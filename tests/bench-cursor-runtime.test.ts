import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { planCursorRuntime } from "../src/lib/bench/cursor-runtime.ts";
import { runProcess } from "../src/lib/bench/process.ts";

const ANCHOR = "const n=null!==(t=be(null==e?void 0:e.failTimeoutMs))&&void 0!==t?t:3e4,r=be(null==e?void 0:e.advisoryTimeoutMs)";
const PINNED_HASH = "39a3fbb76b3382d2ffa82f6a158f292ae4fe0ba06162795dcbbacde325ca9853";
const SOURCE = `// The test never loads or starts a real Cursor installation.\nfunction timeout(e){let t;const be=(v)=>v;${ANCHOR};return [n,r];}\nconst unrelated=3e4;\n`;

function fakeRuntime(options: { source?: string; digest?: string; entry?: string; nodeOptions?: string; compileError?: boolean } = {}) {
  const plan = planCursorRuntime("/tmp/cursor runtime", 120_000);
  const preload = plan.files[0];
  assert.ok(preload);
  const entry = options.entry ?? "/native/cursor/index.js";
  const source = options.source ?? SOURCE;
  const reads: string[] = [];
  const hashInputs: Buffer[] = [];
  const originalCalls: string[] = [];
  let compiled: { source: string; filename: string } | null = null;
  const originalLoader = (_module: object, filename: string): void => { originalCalls.push(filename); };
  const fakeModule = { _extensions: { ".js": originalLoader } };
  const fakeProcess = { argv: ["node", entry], env: { NODE_OPTIONS: options.nodeOptions ?? plan.env.NODE_OPTIONS } };
  const fakeFs = {
    realpathSync(filename: string): string { return path.resolve(filename); },
    readFileSync(filename: string): Buffer { reads.push(filename); return Buffer.from(source); },
  };
  // Successful-path fixtures supply only the trusted digest result. Hash input
  // and algorithm are still checked, while no production hash override exists.
  const fakeCrypto = {
    createHash(algorithm: string) {
      assert.equal(algorithm, "sha256");
      return {
        update(bytes: Buffer) {
          hashInputs.push(bytes);
          return { digest(encoding: string): string { assert.equal(encoding, "hex"); return options.digest ?? PINNED_HASH; } };
        },
      };
    },
  };
  const moduleToCompile = {
    _compile(value: string, filename: string): void {
      assert.equal(fakeModule._extensions[".js"], originalLoader, "native imports must see the restored loader");
      assert.equal(fakeProcess.env.NODE_OPTIONS?.includes(plan.env.NODE_OPTIONS ?? "") ?? false, false, "children must not inherit this preload");
      compiled = { source: value, filename };
      if (options.compileError) throw new Error("fake native compile error");
    },
  };
  return {
    plan, reads, hashInputs, originalCalls, originalLoader, fakeModule, fakeProcess, moduleToCompile,
    compiled: () => compiled,
    install(): void {
      runInNewContext(preload.content, {
        process: fakeProcess,
        require(name: string): object {
          switch (name) {
            case "node:fs": return fakeFs;
            case "node:path": return path;
            case "node:crypto": return fakeCrypto;
            case "node:module": return fakeModule;
            default: throw new Error(`Unexpected dependency: ${name}`);
          }
        },
      });
    },
    load(filename = entry): void { fakeModule._extensions[".js"](moduleToCompile, filename); },
  };
}

test("Cursor runtime plan pins an audited bundle and validates limits without inspecting an installation", () => {
  const plan = planCursorRuntime('/does not exist/with "quote"', 120_000);
  assert.equal(plan.compatibility.version, "2026.07.23-e383d2b");
  assert.equal(plan.compatibility.sourceSha256, PINNED_HASH);
  assert.equal(plan.compatibility.nativeStallTimeoutMs, 120_000);
  assert.equal(plan.compatibility.id, "cursor-2026.07.23-e383d2b-stall-120000-v1");
  assert.equal(plan.env.NODE_OPTIONS, '--require="/does not exist/with \\"quote\\"/cursor-runtime/preload.cjs"');
  assert.equal(plan.files[0]?.mode, 0o600);
  for (const timeout of [29_999, 300_001, 30_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planCursorRuntime("/tmp/home", timeout), /30000–300000/u);
  }
  for (const home of ["relative", "/tmp/line\nbreak", "/tmp/nul\0"]) {
    assert.throws(() => planCursorRuntime(home, 120_000), /绝对路径/u);
  }
  assert.equal(planCursorRuntime("/tmp/home", 30_000).compatibility.nativeStallTimeoutMs, 30_000);
  assert.equal(planCursorRuntime("/tmp/home", 300_000).compatibility.nativeStallTimeoutMs, 300_000);
});

test("Cursor preload changes one default only, restores the loader before native imports, and removes its child-process option", () => {
  const runtime = fakeRuntime();
  runtime.install();
  runtime.load("/native/cursor/submodule.js");
  assert.deepEqual(runtime.originalCalls, ["/native/cursor/submodule.js"]);
  assert.deepEqual(runtime.reads, []);
  runtime.load();
  const compiled = runtime.compiled();
  assert.ok(compiled);
  assert.equal(compiled.source, SOURCE.replace(":3e4,r=be", ":120000,r=be"));
  assert.equal(compiled.filename, "/native/cursor/index.js");
  assert.deepEqual(runtime.hashInputs, [Buffer.from(SOURCE)]);
  assert.deepEqual(runtime.reads, ["/native/cursor/index.js"]);
  assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
  assert.equal(runtime.fakeProcess.env.NODE_OPTIONS, undefined);
  runtime.load("/native/cursor/node_modules/tool/index.js");
  assert.deepEqual(runtime.originalCalls, ["/native/cursor/submodule.js", "/native/cursor/node_modules/tool/index.js"]);
});

test("Cursor preload fails closed for an altered bundle and restores the loader without compiling", () => {
  const runtime = fakeRuntime({ digest: crypto.createHash("sha256").update(SOURCE).digest("hex") });
  runtime.install();
  assert.throws(() => runtime.load(), /unrecognized bundle SHA-256/u);
  assert.equal(runtime.compiled(), null);
  assert.deepEqual(runtime.originalCalls, []);
  assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
});

test("Cursor preload requires exactly one anchor even after the complete digest check", () => {
  for (const source of ["const other=30000;", `${SOURCE}\n// ${ANCHOR}`]) {
    const runtime = fakeRuntime({ source });
    runtime.install();
    assert.throws(() => runtime.load(), /exactly one stall timeout anchor/u);
    assert.equal(runtime.compiled(), null);
    assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
  }
});

test("Cursor preload refuses non-entry invocations instead of silently running without compatibility", () => {
  for (const entry of ["", "/native/cursor/cursor-agent-svc.js", "/native/cursor/main.mjs"]) {
    const runtime = fakeRuntime({ entry });
    assert.throws(() => runtime.install(), /expected the pinned Cursor index.js entry point/u);
    assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
    assert.deepEqual(runtime.reads, []);
  }
});

test("Cursor preload preserves unrelated Node options and stays removed if native compilation fails", () => {
  const owned = planCursorRuntime("/tmp/cursor runtime", 120_000).env.NODE_OPTIONS;
  const runtime = fakeRuntime({ nodeOptions: `--no-warnings ${owned} --trace-warnings`, compileError: true });
  runtime.install();
  assert.throws(() => runtime.load(), /fake native compile error/u);
  assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
  assert.equal(runtime.fakeProcess.env.NODE_OPTIONS, "--no-warnings  --trace-warnings");
});

test("Cursor preload refuses an unremovable or duplicated option before native code can start children", () => {
  const owned = planCursorRuntime("/tmp/cursor runtime", 120_000).env.NODE_OPTIONS;
  for (const nodeOptions of ["--trace-warnings", `prefix${owned}`, `${owned}suffix`, `${owned} ${owned}`]) {
    const runtime = fakeRuntime({ nodeOptions });
    runtime.install();
    assert.throws(() => runtime.load(), /preload option could not be removed safely/u);
    assert.equal(runtime.compiled(), null);
    assert.equal(runtime.fakeModule._extensions[".js"], runtime.originalLoader);
  }
});

test("Cursor runtime preload works in a local fake Node entry and is absent from its child environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-runtime "quoted"-'));
  try {
    const entry = path.join(root, "index.js");
    const child = path.join(root, "child", "index.js");
    const source = SOURCE + `const {spawnSync}=require("node:child_process");const child=spawnSync(process.execPath,[${JSON.stringify(child)}],{encoding:"utf8"});console.log(JSON.stringify({timeout:timeout({})[0],unrelated,childCode:child.status,childOutput:child.stdout.trim(),preloadInherited:typeof process.env.NODE_OPTIONS!=="undefined"}));`;
    const plan = planCursorRuntime(path.join(root, "home"), 120_000);
    const preload = plan.files[0];
    assert.ok(preload);
    await mkdir(path.dirname(preload.path), { recursive: true });
    await mkdir(path.dirname(child), { recursive: true });
    await writeFile(entry, source);
    await writeFile(child, 'console.log("child index.js executed");');
    // The fake process has its own explicit trust fixture. Production offers
    // no alternate digest input and still accepts only the pinned CLI bundle.
    assert.equal(preload.content.split(PINNED_HASH).length, 2);
    await writeFile(preload.path, preload.content.replace(PINNED_HASH, crypto.createHash("sha256").update(source).digest("hex")), { mode: preload.mode });
    const result = await runProcess({ executable: process.execPath, args: [entry], cwd: root, env: plan.env, timeoutMs: 2_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { timeout: 120_000, unrelated: 30_000, childCode: 0, childOutput: "child index.js executed", preloadInherited: false });

    await writeFile(entry, `${source}\n// bundle modified after approval`);
    const rejected = await runProcess({ executable: process.execPath, args: [entry], cwd: root, env: plan.env, timeoutMs: 2_000 });
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.stderr, /unrecognized bundle SHA-256/u);
    assert.equal(rejected.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
