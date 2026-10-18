import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTask, resolveTarget } from "../src/lib/bench/config.ts";
import { gradeTask } from "../src/lib/bench/grader.ts";
import { runProcess } from "../src/lib/bench/process.ts";
import { runBenchmark } from "../src/lib/bench/runner.ts";
import { freezeManifestCheck } from "../src/lib/bench/task-constraints.ts";
import { diffSnapshots, materializeFixture, snapshotFixture, snapshotWorkspace } from "../src/lib/bench/workspace.ts";
import type { BenchTask, ExecutionResult, ProcessResult } from "../src/lib/bench/types.ts";
import { makeLabRoot, withEnvAsync, writeJson, writeText } from "./helpers.ts";

function execution(): ExecutionResult {
  return { status: "completed", text: "done", reasoning: null, usage: null, cost: null, sessionId: null,
    responseModel: null, events: [], error: null, latencyMs: 1, exitCode: 0, stdout: "", stderr: "",
    raw: null, harnessVersion: null, usageSource: null, costSource: null };
}

function processResult(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1 };
}

/** A normal Python environment contains links to the interpreter outside the workspace. */
function virtualEnvironment(directory: string): void {
  writeText(path.join(directory, "pyvenv.cfg"), "home = /test/python\n");
  mkdirSync(path.join(directory, "bin"), { recursive: true });
  symlinkSync(process.execPath, path.join(directory, "bin/python"));
}

function setup(): { root: string; task: BenchTask; workspace: string } {
  const root = makeLabRoot();
  const fixture = path.join(root, "fixture");
  writeText(path.join(fixture, "style/design.md"), "frozen style\n");
  const task: BenchTask = { name: "render", prompt: "render", fixture: "fixture", timeoutMs: 1000,
    checks: [freezeManifestCheck(fixture, { immutable: ["style/**"], allowNewFiles: true })] };
  const workspace = path.join(root, "data/workspace");
  materializeFixture(root, task, workspace);
  return { root, task, workspace };
}

test("candidate-created root and nested venvs do not hide generated source or output from snapshots and manifest", async (t) => {
  const { root, task, workspace } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = snapshotFixture(root, task);
  virtualEnvironment(path.join(workspace, "venv"));
  virtualEnvironment(path.join(workspace, "project/.venv"));
  writeText(path.join(workspace, "project/render.py"), "print('source')\n");
  writeText(path.join(workspace, "output.mp4"), "opaque artifact\n");
  const changes = diffSnapshots(baseline, snapshotWorkspace(workspace, baseline));
  assert.deepEqual(changes.map((file) => file.path), ["output.mp4", "project/render.py"]);
  assert.equal((await gradeTask(task, execution(), workspace)).status, "passed");
  assert.throws(() => snapshotWorkspace(workspace), /符号链接/u, "source snapshots remain strict by default");
  writeText(path.join(workspace, "style/design.md"), "tampered\n");
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed");
});

test("a venv directory symlink and other external symlinks are rejected by both candidate checks", async (t) => {
  const { root, task, workspace } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = snapshotFixture(root, task);
  for (const name of ["venv", ".venv", "linked-file"]) {
    symlinkSync(name === "linked-file" ? process.execPath : path.join(root, "fixture"), path.join(workspace, name));
    assert.throws(() => snapshotWorkspace(workspace, baseline), /符号链接/u);
    assert.equal((await gradeTask(task, execution(), workspace)).status, "failed", name);
    rmSync(path.join(workspace, name));
  }
});

test("fixtures keep venv files visible and reject interpreter symlinks when freezing or copying", (t) => {
  const { root, task } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  writeText(path.join(fixture, "venv/input.txt"), "original input\n");
  assert.ok(snapshotFixture(root, task).files.some((file) => file.path === "venv/input.txt"));
  virtualEnvironment(path.join(fixture, "venv"));
  assert.throws(() => snapshotFixture(root, task), /符号链接/u);
  assert.throws(() => materializeFixture(root, task, path.join(root, "data/copy")), /符号链接/u);
  assert.throws(() => freezeManifestCheck(fixture, { immutable: ["venv/**"] }), /符号链接/u);
});

test("immutable fixture inputs beneath venv stay hashed and cannot disappear behind the runtime omission", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  writeText(path.join(fixture, "nested/venv/input.csv"), "frozen\n");
  const task: BenchTask = { name: "inputs", prompt: "x", fixture: "fixture", timeoutMs: 1000,
    checks: [freezeManifestCheck(fixture, { immutable: ["nested/venv/**"], allowNewFiles: true })] };
  const workspace = path.join(root, "data/workspace");
  materializeFixture(root, task, workspace);
  const baseline = snapshotFixture(root, task);
  assert.deepEqual(snapshotWorkspace(workspace, baseline), baseline);
  writeText(path.join(workspace, "nested/venv/input.csv"), "tampered\n");
  assert.deepEqual(diffSnapshots(baseline, snapshotWorkspace(workspace, baseline)).map((file) => file.kind), ["modified"]);
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed");
  rmSync(path.join(workspace, "nested/venv/input.csv"));
  assert.deepEqual(diffSnapshots(baseline, snapshotWorkspace(workspace, baseline)).map((file) => file.kind), ["deleted"]);
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed");
  symlinkSync(process.execPath, path.join(workspace, "nested/venv/python"));
  assert.throws(() => snapshotWorkspace(workspace, baseline), /符号链接/u);
  assert.equal((await gradeTask(task, execution(), workspace)).status, "failed");
});

test("benchmark keeps a completed sample and actual changes when a fake harness creates its venv", async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeText(path.join(root, "fixture/style/design.md"), "original\n");
  writeJson(path.join(root, "providers/test.json"), { name: "test", baseURL: "https://example.test/v1", apiKeyEnv: "TEST_VENV_KEY",
    endpoints: { responses: "https://example.test/v1" } });
  writeJson(path.join(root, "harnesses/codex.json"), { name: "codex", adapter: "codex", executable: "fake-codex", permission: "workspace-write" });
  writeJson(path.join(root, "targets/agent.json"), { name: "agent", kind: "harness", harness: "codex", backend: { provider: "test", model: "fake", protocol: "responses" } });
  writeJson(path.join(root, "tasks/render.json"), { name: "render", prompt: "render", fixture: "fixture", timeoutMs: 5000,
    manifest: { immutable: ["style/**"], allowNewFiles: true }, checks: [{ kind: "file-exists", path: "render.py" }] });
  await withEnvAsync({ TEST_VENV_KEY: "fake-venv-key" }, async () => {
    const result = await runBenchmark(root, { task: loadTask(root, "render"), targets: [resolveTarget(root, "agent")], repeat: 1, concurrency: 1 }, {
      runProcess: async (request) => {
        if (request.executable === process.execPath) return runProcess(request);
        if (request.args[0] === "--version") return processResult("fake codex\n");
        virtualEnvironment(path.join(request.cwd, ".venv"));
        writeText(path.join(request.cwd, "render.py"), "# generated source\n");
        return processResult([
          { type: "thread.started", thread_id: "offline-venv" },
          { type: "item.completed", item: { type: "agent_message", text: "done" } },
          { type: "turn.completed" },
        ].map((event) => JSON.stringify(event)).join("\n"));
      },
    });
    assert.equal(result.failed, false);
    assert.equal(result.records[0]?.execution.status, "completed");
    assert.equal(result.records[0]?.grade.status, "passed");
    assert.deepEqual(result.records[0]?.changes.map((file) => file.path), ["render.py"]);
  });
});
