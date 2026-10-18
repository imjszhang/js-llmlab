import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTask, resolveTarget, validateTaskTarget } from "../src/lib/bench/config.ts";
import { gradeTask } from "../src/lib/bench/grader.ts";
import { runProcess } from "../src/lib/bench/process.ts";
import { initTask } from "../src/lib/bench/task-authoring.ts";
import { validateTask } from "../src/lib/bench/task-validation.ts";
import { materializeFixture } from "../src/lib/bench/workspace.ts";
import type { ExecutionResult } from "../src/lib/bench/types.ts";
import { makeCommandLab, makeLabRoot, writeJson, writeText } from "./helpers.ts";

function execution(text = "done"): ExecutionResult {
  return {
    status: "completed", text, reasoning: null, usage: null, cost: null, sessionId: null,
    responseModel: null, events: [], error: null, latencyMs: 0, exitCode: 0, stdout: text,
    stderr: "", raw: null, harnessVersion: null, usageSource: null, costSource: null,
  };
}

for (const template of ["repair", "data", "answer"] as const) {
  test(`${template} task template self-tests initial, reference and negative in isolated temporary workspaces`, async (t) => {
    const root = makeLabRoot();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const generated = initTask(root, `example-${template}`, template);
    assert.equal(generated.name, `example-${template}`);
    assert.ok(generated.files.includes(`tasks/example-${template}.json`));
    assert.ok(generated.files.every((file) => existsSync(path.join(root, file))));
    const task = loadTask(root, generated.name);
    assert.equal(task.requires, template === "answer" ? undefined : "workspace-write");
    const workspaces = new Set<string>();
    const result = await validateTask(root, generated.name, { runProcess: async (request) => {
      workspaces.add(request.cwd);
      assert.deepEqual(request.env, {});
      assert.notEqual(request.cwd.startsWith(root), true);
      return runProcess(request);
    } });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(result.checks.map((check) => check.name), ["structure", "initial", "reference", `negative-1-${template === "repair" ? "multiply" : template === "data" ? "wrong-total" : "wrong-answer"}`]);
    assert.equal(workspaces.size, 3);
    assert.ok([...workspaces].every((workspace) => !existsSync(workspace)), "temporary workspaces are removed");
    assert.ok(!existsSync(path.join(root, "data", "benchmarks")), "validation does not create experiment records");
    if (template !== "answer") assert.ok(!readFileSync(path.join(root, task.fixture ?? "", template === "repair" ? "src/add.mjs" : "transform.mjs"), "utf8").includes("a + b"), "reference code never replaces source fixture");
  });
}

test("legacy repository tasks load with exactly the previous fields and validate without fabricated self-test evidence", async () => {
  for (const name of ["hello", "fix-add", "fix-order-total", "normalize-orders"]) {
    const task = loadTask(process.cwd(), name);
    const expected = task.fixture === undefined ? ["checks", "name", "prompt", "timeoutMs"] : ["checks", "fixture", "name", "prompt", "timeoutMs"];
    assert.deepEqual(Object.keys(task).sort(), expected);
    const validation = await validateTask(process.cwd(), name, { runProcess: async () => { throw new Error("legacy structural validation must not run a process"); } });
    assert.equal(validation.passed, true);
    assert.deepEqual(validation.checks.map((check) => check.name), ["structure"]);
    assert.match(validation.diagnostics.join("\n"), /仅完成结构校验/u);
    assert.match(validation.diagnostics.join("\n"), /未验证/u);
  }
});

test("script file source is frozen into command argv and is independent of later host or workspace edits", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask(root, "frozen", "repair");
  const task = loadTask(root, "frozen");
  const script = task.checks[0];
  assert.equal(script?.kind, "command");
  if (script?.kind !== "command") throw new Error("expected frozen command");
  const source = script.argv[3];
  assert.match(source ?? "", /repair acceptance passed/u);
  writeText(path.join(root, "tasks/checks/frozen.mjs"), 'throw new Error("new checker");\n');
  const workspace = path.join(root, "data", "sample");
  materializeFixture(root, task, workspace);
  copyFileSync(path.join(root, "tasks/self-tests/frozen/reference/src/add.mjs"), path.join(workspace, "src/add.mjs"));
  assert.equal((await gradeTask(task, execution(), workspace)).status, "passed");
  assert.equal(script.argv[3], source);
  assert.equal((await gradeTask(loadTask(root, "frozen"), execution(), workspace)).status, "failed");
  writeText(path.join(workspace, "src/add.mjs"), "process.exit(0); export function add() {}\n");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed", "candidate early exit cannot bypass trusted parent");
});

test("self-test catches a supposedly failing initial state or a negative case that actually passes", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask(root, "bad-self-test", "repair");
  const file = path.join(root, "tasks/bad-self-test.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.selfTest.initial = "pass";
  writeJson(file, raw);
  const wrongInitial = await validateTask(root, "bad-self-test");
  assert.equal(wrongInitial.passed, false);
  assert.equal(wrongInitial.checks.find((check) => check.name === "initial")?.passed, false);
  raw.selfTest.initial = "fail";
  raw.selfTest.negative[0].files = raw.selfTest.reference.files;
  writeJson(file, raw);
  const wrongNegative = await validateTask(root, "bad-self-test");
  assert.equal(wrongNegative.passed, false);
  assert.equal(wrongNegative.checks.find((check) => check.name.startsWith("negative-"))?.passed, false);
});

test("answer equality ignores surrounding whitespace, rejects extra content and leaves contains checks unchanged", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask(root, "answer", "answer");
  const task = loadTask(root, "answer");
  const workspace = path.join(root, "data", "answer");
  materializeFixture(root, task, workspace);
  assert.equal((await gradeTask(task, execution("\n 42 \n"), workspace)).status, "passed");
  assert.equal((await gradeTask(task, execution("142"), workspace)).status, "failed");
  assert.equal((await gradeTask(task, execution("The answer is 42"), workspace)).status, "failed");
  const contains = { name: "legacy", prompt: "x", timeoutMs: 100, checks: [{ kind: "output-contains", text: "42" } as const] };
  assert.equal((await gradeTask(contains, execution("142"), workspace)).status, "passed");
});

test("manifest permits declared edits and additions while freezing unrelated existing files automatically", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeText(path.join(root, "tasks/fixtures/manifest/SPEC.md"), "immutable specification\n");
  writeText(path.join(root, "tasks/fixtures/manifest/src/a.mjs"), "initial\n");
  writeText(path.join(root, "tasks/fixtures/manifest/input.csv"), "input\n");
  writeJson(path.join(root, "tasks/manifest.json"), {
    name: "manifest", prompt: "test", fixture: "tasks/fixtures/manifest",
    manifest: { immutable: ["SPEC.md"], editable: ["src/**", "generated/result.json"], allowNewFiles: true },
    checks: [{ kind: "output-contains", text: "done" }],
  });
  const task = loadTask(root, "manifest");
  const workspace = path.join(root, "data", "sample");
  materializeFixture(root, task, workspace);
  writeText(path.join(workspace, "src/a.mjs"), "edited\n");
  writeText(path.join(workspace, "src/new.mjs"), "allowed\n");
  writeText(path.join(workspace, "generated/result.json"), "{}\n");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "passed");
  writeText(path.join(workspace, "input.csv"), "tampered\n");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed", "unlisted input stays frozen");
  writeText(path.join(workspace, "input.csv"), "input\n");
  writeText(path.join(workspace, "other.txt"), "forbidden\n");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed", "new path must match editable");
  rmSync(path.join(workspace, "other.txt"));
  rmSync(path.join(workspace, "SPEC.md"));
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed", "immutable deletion fails");
});

test("manifest immutable-only does not freeze all other fixture files and no-new-files is explicit", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeText(path.join(root, "fixture/SPEC.md"), "spec");
  writeText(path.join(root, "fixture/editable.txt"), "old");
  const raw = { name: "manifest", prompt: "test", fixture: "fixture", manifest: { immutable: ["SPEC.md"], allowNewFiles: true }, checks: [] };
  writeJson(path.join(root, "tasks/manifest.json"), raw);
  const task = loadTask(root, "manifest");
  const workspace = path.join(root, "data", "sample");
  materializeFixture(root, task, workspace);
  writeText(path.join(workspace, "editable.txt"), "changed");
  writeText(path.join(workspace, "new.txt"), "new");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "passed");
  raw.manifest.allowNewFiles = false;
  writeJson(path.join(root, "tasks/manifest.json"), raw);
  assert.equal((await gradeTask(loadTask(root, "manifest"), execution(), workspace)).status, "failed");
  rmSync(path.join(workspace, "new.txt"));
  symlinkSync(path.join(root, "fixture/editable.txt"), path.join(workspace, "linked.txt"));
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed");
});

test("task authoring refuses all existing generated destinations before writing anything", (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeText(path.join(root, "tasks/checks/existing.mjs"), "keep\n");
  assert.throws(() => initTask(root, "existing", "repair"), /拒绝覆盖/u);
  assert.equal(readFileSync(path.join(root, "tasks/checks/existing.mjs"), "utf8"), "keep\n");
  assert.equal(existsSync(path.join(root, "tasks/existing.json")), false);
  assert.equal(existsSync(path.join(root, "tasks/prompts/existing.md")), false);
  mkdirSync(path.join(root, "tasks/fixtures/occupied"), { recursive: true });
  assert.throws(() => initTask(root, "occupied", "data"), /拒绝覆盖/u);
  initTask(root, "created", "repair");
  assert.throws(() => initTask(root, "created", "repair"), /拒绝覆盖/u);
  for (const name of ["../escape", "/absolute", "a/b", "archives", "node_modules"]) assert.throws(() => initTask(root, name, "repair"));
});

test("task source paths, self-test overlays and generated destinations reject symlinks and private paths", async (t) => {
  const root = makeLabRoot();
  const outside = makeLabRoot();
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(path.join(root, "tasks"), { recursive: true });
  writeText(path.join(root, "safe.mjs"), "console.log('safe');\n");
  symlinkSync(path.join(root, "safe.mjs"), path.join(root, "linked.mjs"));
  for (const file of ["../escape.mjs", "/tmp/escape.mjs", ".env", "archives/check.mjs", "linked.mjs"]) {
    writeJson(path.join(root, "tasks/unsafe.json"), { name: "unsafe", prompt: "x", checks: [{ kind: "script", file }] });
    assert.equal((await validateTask(root, "unsafe")).passed, false);
  }
  symlinkSync(outside, path.join(root, "tasks/fixtures"));
  assert.throws(() => initTask(root, "safe-name", "repair"), /符号链接/u);
  assert.equal(existsSync(path.join(outside, "safe-name")), false);
  rmSync(path.join(root, "tasks/fixtures"));
  initTask(root, "overlay", "repair");
  symlinkSync(path.join(root, "safe.mjs"), path.join(root, "tasks/self-tests/overlay/reference/linked.mjs"));
  const validation = await validateTask(root, "overlay");
  assert.equal(validation.passed, false);
  assert.match(validation.checks.map((check) => check.detail).join("\n"), /符号链接/u);
});

test("manifest patterns and self-tests cannot overlap immutable/editable paths or expose reference inside fixture", (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask(root, "bad-manifest", "repair");
  const file = path.join(root, "tasks/bad-manifest.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const manifest of [
    { immutable: ["../SPEC.md"] }, { editable: ["src/*.mjs"] }, { editable: ["archives/**"] },
    { immutable: ["missing.txt"] }, { immutable: ["SPEC.md"], editable: ["SPEC.md"] }, { allowNewFiles: "true" }, {},
  ]) {
    writeJson(file, { ...raw, manifest });
    assert.throws(() => loadTask(root, "bad-manifest"));
  }
  raw.selfTest.reference.files = raw.fixture;
  writeJson(file, raw);
  assert.throws(() => loadTask(root, "bad-manifest"), /参考解不得进入候选工作区/u);
});

test("explicit write requirements reject direct LLM and read-only harness before execution without affecting old tasks", (t) => {
  const { root } = makeCommandLab();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initTask(root, "write-task", "repair");
  writeJson(path.join(root, "targets/llm.json"), { name: "llm", kind: "llm", config: "a" });
  for (const permission of ["read-only", "workspace-write"] as const) {
    const name = permission === "read-only" ? "read" : "write";
    writeJson(path.join(root, `harnesses/${name}.json`), { name, adapter: "codex", executable: "codex", permission });
    writeJson(path.join(root, `targets/${name}.json`), { name, kind: "harness", harness: name, backend: { provider: "test", model: "a", protocol: "responses" } });
  }
  writeJson(path.join(root, "providers/test.json"), { name: "test", apiKeyEnv: "NOT_NEEDED", endpoints: { responses: "https://example.test/v1" } });
  const task = loadTask(root, "write-task");
  assert.throws(() => validateTaskTarget(task, resolveTarget(root, "llm")), /需要 workspace-write/u);
  assert.throws(() => validateTaskTarget(task, resolveTarget(root, "read")), /需要 workspace-write/u);
  assert.doesNotThrow(() => validateTaskTarget(task, resolveTarget(root, "write")));
  const oldTask = { name: "old", prompt: "x", timeoutMs: 1, checks: [] };
  assert.doesNotThrow(() => validateTaskTarget(oldTask, resolveTarget(root, "llm")));
  assert.doesNotThrow(() => validateTaskTarget(oldTask, resolveTarget(root, "read")));
});
