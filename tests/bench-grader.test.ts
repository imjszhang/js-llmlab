import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gradeTask } from "../src/lib/bench/grader.ts";
import type { BenchTask, ExecutionResult, ProcessRequest, ProcessResult, TaskCheck } from "../src/lib/bench/types.ts";
import { withEnvAsync } from "./helpers.ts";

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    status: "completed", text: "Expected answer", reasoning: null, usage: null, cost: null,
    sessionId: null, responseModel: null, events: [], error: null, latencyMs: 1,
    exitCode: null, stdout: "", stderr: "", raw: null, harnessVersion: null,
    usageSource: "request", costSource: null, ...overrides,
  };
}
function task(checks: TaskCheck[]): BenchTask { return { name: "test", prompt: "test", timeoutMs: 100, checks }; }
function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1, ...overrides };
}

test("grader checks actual output and files and reports ordinary assertion failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "llmlab-grade-"));
  try {
    await writeFile(path.join(workspace, "answer.txt"), "Expected file content");
    const passed = await gradeTask(task([
      { kind: "output-contains", text: "Expected" },
      { kind: "file-exists", path: "answer.txt" },
      { kind: "file-contains", path: "answer.txt", text: "file content" },
    ]), result(), workspace);
    assert.equal(passed.status, "passed");
    assert.equal(passed.checks.length, 3);
    const failed = await gradeTask(task([
      { kind: "output-contains", text: "absent" },
      { kind: "file-exists", path: "missing.txt" },
      { kind: "file-contains", path: "answer.txt", text: "absent" },
    ]), result(), workspace);
    assert.equal(failed.status, "failed");
    assert.ok(failed.checks.every((check) => !check.passed));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("grader skips failed execution and tasks without checks", async () => {
  const checks: TaskCheck[] = [{ kind: "command", argv: ["never"], timeoutMs: 10 }];
  const runner = async (): Promise<ProcessResult> => { throw new Error("Must not run"); };
  assert.deepEqual(await gradeTask(task(checks), result({ status: "failed" }), "/unused", { runProcess: runner }), { status: "not-run", checks: [] });
  assert.deepEqual(await gradeTask(task(checks), result({ status: "timeout" }), "/unused", { runProcess: runner }), { status: "not-run", checks: [] });
  assert.deepEqual(await gradeTask(task([]), result(), "/unused", { runProcess: runner }), { status: "not-run", checks: [] });
});

test("grader executes argv without shell in workspace and gives checker no model credentials", async () => {
  const requests: ProcessRequest[] = [];
  const checked = await gradeTask(task([{ kind: "command", argv: ["node", "literal;argument", "$(literal)"], timeoutMs: 31 }]), result(), "/workspace", {
    runProcess: async (request) => { requests.push(request); return processResult({ stdout: "ok" }); },
  });
  assert.equal(checked.status, "passed");
  assert.deepEqual(requests, [{ executable: "node", args: ["literal;argument", "$(literal)"], cwd: "/workspace", env: {}, timeoutMs: 31 }]);
});

test("grader distinguishes nonzero assertion exits from checker timeout and spawn failures", async () => {
  const check: TaskCheck = { kind: "command", argv: ["check"], timeoutMs: 10 };
  for (const [outcome, expected] of [
    [processResult({ exitCode: 1 }), "failed"],
    [processResult({ exitCode: null, error: "ENOENT" }), "error"],
    [processResult({ exitCode: null, timedOut: true }), "error"],
    [processResult({ exitCode: null, signal: "SIGTERM" }), "error"],
  ] as const) {
    const checked = await gradeTask(task([check]), result(), "/workspace", { runProcess: async () => outcome });
    assert.equal(checked.status, expected);
  }
});

test("grader rejects outside paths and symlink escapes including missing descendants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "llmlab-grade-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  try {
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "external data");
    await symlink(outside, path.join(workspace, "linked"));
    for (const relative of ["../outside/secret.txt", path.join(outside, "secret.txt"), "linked/secret.txt", "linked/missing.txt"]) {
      const checked = await gradeTask(task([{ kind: "file-contains", path: relative, text: "external data" }]), result(), workspace);
      assert.equal(checked.status, "error", relative);
      assert.equal(checked.checks[0]?.passed, false);
      assert.ok(!JSON.stringify(checked).includes("external data\n"));
    }
    await writeFile(path.join(workspace, "inside.txt"), "inside");
    await symlink("inside.txt", path.join(workspace, "safe-link"));
    const inside = await gradeTask(task([{ kind: "file-contains", path: "safe-link", text: "inside" }]), result(), workspace);
    assert.equal(inside.status, "passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("grader redacts checker stdout/stderr/errors and check metadata", async () => {
  await withEnvAsync({ CHECKER_API_KEY: "fake-checker-secret" }, async () => {
    const checked = await gradeTask(task([{ kind: "command", argv: ["checker", "fake-checker-secret"], timeoutMs: 1 }]), result(), "/workspace", {
      runProcess: async () => processResult({ stdout: "fake-checker-secret", stderr: "fake-checker-secret", error: "fake-checker-secret", exitCode: null }),
    });
    assert.equal(checked.status, "error");
    assert.ok(!JSON.stringify(checked).includes("fake-checker-secret"));
  });
});
