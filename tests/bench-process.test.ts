import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "../src/lib/bench/process.ts";
import { withEnvAsync } from "./helpers.ts";

test("bench process runs argv without a shell, closes stdin, and preserves both output streams", async () => {
  const result = await runProcess({ executable: process.execPath, args: ["-e", 'process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",s=>text+=s);process.stdin.on("end",()=>{console.log(JSON.stringify({text,args:process.argv.slice(1)}));console.error("diagnostic");});', '$(echo accidental)'], cwd: process.cwd(), stdin: "task\n", timeoutMs: 2000 });
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), { text: "task\n", args: ["$(echo accidental)"] });
  assert.equal(result.stderr, "diagnostic\n");
});

test("bench process does not inherit provider secrets, nested harness markers, or parent HOME", async () => {
  const names = ["LLMCORE_API_KEY", "CLAUDECODE", "CODEX_HOME", "ANTHROPIC_API_KEY"];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = "parent-only";
    const result = await runProcess({ executable: process.execPath, args: ["-e", 'console.log(JSON.stringify({home:process.env.HOME,key:process.env.ANTHROPIC_API_KEY,other:process.env.LLMCORE_API_KEY,nested:process.env.CLAUDECODE,codex:process.env.CODEX_HOME}));'], cwd: process.cwd(), env: { HOME: "/isolated", ANTHROPIC_API_KEY: "selected-only" }, timeoutMs: 2000 });
    assert.deepEqual(JSON.parse(result.stdout), { home: "/isolated", key: "selected-only" });
    assert.equal(process.env.ANTHROPIC_API_KEY, "parent-only");
  } finally {
    names.forEach((name, index) => { const value = previous[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  }
});

test("bench process forwards all standard proxy spellings and honors explicit overrides without unrelated credentials", async () => {
  const proxies = {
    HTTP_PROXY: "http://upper-http.test:8080", HTTPS_PROXY: "http://upper-https.test:8080",
    ALL_PROXY: "socks5://upper-all.test:1080", NO_PROXY: "localhost,.upper.test",
    http_proxy: "http://lower-http.test:8080", https_proxy: "http://lower-https.test:8080",
    all_proxy: "socks5://lower-all.test:1080", no_proxy: "localhost,.lower.test",
  };
  await withEnvAsync({ ...proxies, NETWORK_TEST_API_KEY: "unrelated-network-test-key" }, async () => {
    const result = await runProcess({ executable: process.execPath,
      args: ["-e", `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([...Object.keys(proxies), "NETWORK_TEST_API_KEY"])}.map(name=>[name,process.env[name]]))))`],
      cwd: process.cwd(), env: { HTTPS_PROXY: "", http_proxy: "http://explicit.test:8080" }, timeoutMs: 2000 });
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ...proxies, HTTPS_PROXY: "", http_proxy: "http://explicit.test:8080" });
    assert.equal(process.env.HTTPS_PROXY, proxies.HTTPS_PROXY);
    assert.equal(process.env.http_proxy, proxies.http_proxy);
  });
});

test("bench process structures missing executable and nonzero exits", async () => {
  const missing = await runProcess({ executable: "/definitely-missing-js-llmlab-harness", args: [], cwd: process.cwd(), timeoutMs: 2000 });
  assert.match(missing.error ?? "", /ENOENT/u);
  assert.equal(missing.timedOut, false);
  const failed = await runProcess({ executable: process.execPath, args: ["-e", 'console.error("failure");process.exit(7);'], cwd: process.cwd(), timeoutMs: 2000 });
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderr, "failure\n");
});

test("bench process output is bounded and overflow cancels a process", async () => {
  const result = await runProcess({ executable: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(10000));setInterval(()=>{},1000);'], cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 1000 });
  assert.equal(Buffer.byteLength(result.stdout), 1000);
  assert.match(result.error ?? "", /exceeded 1000 bytes/u);
  assert.equal(result.timedOut, false);
  assert.ok(result.latencyMs < 1900);
});

test("bench process timeout terminates a SIGTERM-ignoring process group including descendants", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bench-process-"));
  try {
    const descendantSource = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const source = `const {spawn}=require("node:child_process");process.on("SIGTERM",()=>{});const child=spawn(process.execPath,["-e",${JSON.stringify(descendantSource)}],{stdio:"inherit"});console.log(child.pid);setInterval(()=>{},1000);`;
    const result = await runProcess({ executable: process.execPath, args: ["-e", source], cwd: dir, timeoutMs: 250 });
    assert.equal(result.timedOut, true);
    assert.match(result.error ?? "", /timed out/u);
    assert.ok(result.latencyMs < 1500);
    assert.match(result.stdout, /^\d+\n$/u);
    // A killed descendant may remain a zombie briefly; its inherited pipes must already be closed.
    assert.equal(result.signal, "SIGKILL");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bench process handles an exited leader whose child keeps output pipes open", { skip: process.platform === "win32" }, async () => {
  const result = await runProcess({ executable: process.execPath, args: ["-e", 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});process.exit(0);'], cwd: process.cwd(), timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  assert.ok(result.latencyMs < 1500);
});

test("bench process grants a harness time to reap its independent child before force killing it", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bench-harness-cleanup-"));
  const childPid = path.join(dir, "child.pid");
  const cleanup = path.join(dir, "cleanup.done");
  const descendant = `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>{},1000);`;
  const source = `const fs=require("node:fs");const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:true,stdio:"ignore"});process.on("SIGTERM",()=>{setTimeout(()=>{child.once("exit",()=>{fs.writeFileSync(${JSON.stringify(cleanup)},"reaped");process.exit(0);});process.kill(child.pid,"SIGKILL");},450);});setInterval(()=>{},1000);`;
  try {
    const result = await runProcess({ executable: process.execPath, args: ["-e", source], cwd: dir, timeoutMs: 250, terminationGraceMs: 1200 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(await readFile(cleanup, "utf8"), "reaped");
    assert.ok(result.latencyMs >= 650, `cleanup was cut short after ${String(result.latencyMs)}ms`);
    assert.ok(result.latencyMs < 2000);
    const reapedPid = Number(await readFile(childPid, "utf8"));
    assert.throws(() => process.kill(reapedPid, 0));
  } finally {
    try { process.kill(-Number(await readFile(childPid, "utf8")), "SIGKILL"); } catch { /* already reaped */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test("bench process validates limits before spawning", async () => {
  const result = await runProcess({ executable: process.execPath, args: [], cwd: process.cwd(), timeoutMs: 0 });
  assert.match(result.error ?? "", /positive integers/u);
  const invalid = await runProcess({ executable: process.execPath, args: ["contains\0nul"], cwd: process.cwd(), timeoutMs: 1000 });
  assert.match(invalid.error ?? "", /null bytes/u);
  for (const terminationGraceMs of [-1, 1.5, 30_001, Number.NaN]) {
    const invalidGrace = await runProcess({ executable: "/never-spawn-invalid-grace", args: [], cwd: process.cwd(), timeoutMs: 1000, terminationGraceMs });
    assert.match(invalidGrace.error ?? "", /terminationGraceMs.*between 0 and 30000/u);
  }
  const immediate = await runProcess({ executable: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 100, terminationGraceMs: 0 });
  assert.equal(immediate.timedOut, true);
});

test("bench process shares signal listeners across concurrent children and restores them on completion", async () => {
  const before = ["SIGINT", "SIGTERM", "exit"].map((name) => process.listenerCount(name));
  const pending = Array.from({ length: 14 }, () => runProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 100 }));
  assert.deepEqual(["SIGINT", "SIGTERM", "exit"].map((name) => process.listenerCount(name)), before.map((count) => count + 1));
  await Promise.all(pending);
  assert.deepEqual(["SIGINT", "SIGTERM", "exit"].map((name) => process.listenerCount(name)), before);
});

test("bench parent signal handoff waits for the longest active harness cleanup grace", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    await t.test(signal, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bench-parent-grace-"));
      const ready = [path.join(dir, "short.pid"), path.join(dir, "long.pid")];
      const cleanup = path.join(dir, "cleanup.done");
      const sources = ready.map((file, index) => `const fs=require("node:fs");process.on("SIGTERM",()=>{${index === 1 ? `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(cleanup)},"completed");process.exit(0);},450);` : ""}});fs.writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`);
      const source = `import {runProcess} from ${JSON.stringify(new URL("../src/lib/bench/process.ts", import.meta.url).href)};await Promise.all(${JSON.stringify(sources)}.map((source,index)=>runProcess({executable:process.execPath,args:["-e",source],cwd:${JSON.stringify(dir)},timeoutMs:5000,...(index===1?{terminationGraceMs:1200}:{})})));`;
      const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      parent.stderr.setEncoding("utf8");
      parent.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        parent.on("error", reject);
        parent.on("close", (code, closingSignal) => resolve({ code, signal: closingSignal }));
      });
      try {
        let started = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await Promise.all(ready.map((file) => access(file).then(() => true, () => false)))).every(Boolean)) { started = true; break; }
          await delay(20);
        }
        assert.equal(started, true, `Fake harnesses did not become ready: ${stderr}`);
        parent.kill(signal);
        const result = await closed;
        assert.equal(result.signal, signal);
        assert.equal(await readFile(cleanup, "utf8"), "completed");
        assert.equal(stderr, "");
      } finally {
        parent.kill("SIGKILL");
        for (const file of ready) {
          try { process.kill(Number(await readFile(file, "utf8")), "SIGKILL"); } catch { /* already reaped */ }
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("bench parent signal and exit cleanup stop every child without changing a caller's exit policy", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  for (const mode of ["SIGINT", "SIGTERM", "exit", "custom"] as const) {
    await t.test(mode, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bench-parent-"));
      const pids = Array.from({ length: 3 }, (_, index) => path.join(dir, `${String(index)}.pid`));
      const markers = Array.from({ length: 3 }, (_, index) => path.join(dir, `${String(index)}.continued`));
      const queuedMarker = path.join(dir, "queued-process-started");
      const childSources = pids.map((file, index) => `const fs=require("node:fs");process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});fs.writeFileSync(${JSON.stringify(file)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(markers[index])},"continued"),800);setInterval(()=>{},1000);`);
      const policy = mode === "custom" ? 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(42),250));' : mode === "exit" ? 'process.on("SIGUSR1",()=>process.exit(37));' : "";
      const queuedSource = `require("node:fs").writeFileSync(${JSON.stringify(queuedMarker)},"started");`;
      const afterInterruptedRun = mode === "SIGINT" || mode === "SIGTERM" ? `await runProcess({executable:process.execPath,args:["-e",${JSON.stringify(queuedSource)}],cwd:${JSON.stringify(dir)},timeoutMs:1000});` : "";
      const source = `import {runProcess} from ${JSON.stringify(new URL("../src/lib/bench/process.ts", import.meta.url).href)};${policy}await Promise.all(${JSON.stringify(childSources)}.map(source=>runProcess({executable:process.execPath,args:["-e",source],cwd:${JSON.stringify(dir)},timeoutMs:5000})));${afterInterruptedRun}`;
      const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      parent.stderr.setEncoding("utf8");
      parent.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        parent.on("error", reject);
        parent.on("close", (code, signal) => resolve({ code, signal }));
      });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await Promise.all(pids.map((file) => access(file).then(() => true, () => false))).then((items) => items.every(Boolean))) { ready = true; break; }
          await delay(20);
        }
        assert.equal(ready, true, `Fake children did not become ready: ${stderr}`);
        parent.kill(mode === "custom" ? "SIGTERM" : mode === "exit" ? "SIGUSR1" : mode);
        const result = await closed;
        if (mode === "custom") assert.equal(result.code, 42);
        else if (mode === "exit") assert.equal(result.code, 37);
        else assert.equal(result.signal, mode);
        assert.equal(stderr, "");
        assert.equal(await access(queuedMarker).then(() => true, () => false), false);
        // Wait beyond the fake write: orphaned harnesses would leave observable task side effects.
        await delay(650);
        assert.deepEqual(await Promise.all(markers.map((file) => access(file).then(() => true, () => false))), [false, false, false]);
      } finally {
        parent.kill("SIGKILL");
        for (const file of pids) {
          try { process.kill(Number(await readFile(file, "utf8")), "SIGKILL"); } catch { /* already reaped */ }
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
