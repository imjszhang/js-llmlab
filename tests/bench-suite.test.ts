import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadTask, resolveTarget } from "../src/lib/bench/config.ts";
import { describeBenchSuite, listBenchSuiteRuns, listBenchSuites, loadBenchSuite, loadBenchSuiteDefinition, readBenchSuite, runBenchSuite, suiteDir } from "../src/lib/bench/suite.ts";
import { describeBenchmark, runBenchmark } from "../src/lib/bench/runner.ts";
import { readBenchmark } from "../src/lib/bench/store.ts";
import type { ProcessResult, ProcessRunner } from "../src/lib/bench/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson, writeText } from "./helpers.ts";

function lab(): ReturnType<typeof makeCommandLab> {
  const result = makeCommandLab();
  const { root } = result;
  writeJson(path.join(root, "providers", "test.json"), { name: "test", baseURL: "https://example.test/v1", model: "demo", apiKeyEnv: "TEST_KEY", maxRetries: 0,
    endpoints: { responses: "https://example.test/v1" } });
  writeJson(path.join(root, "harnesses", "codex.json"), { name: "codex", adapter: "codex", executable: "fake-codex", permission: "workspace-write" });
  for (const name of ["agent-a", "agent-b"]) writeJson(path.join(root, "targets", `${name}.json`), { name, kind: "harness", harness: "codex", backend: { provider: "test", model: "demo", protocol: "responses" } });
  writeJson(path.join(root, "targets", "direct.json"), { name: "direct", kind: "llm", config: "a" });
  for (const name of ["alpha", "beta"]) {
    writeText(path.join(root, "fixtures", name, "input.txt"), `${name} original`);
    writeJson(path.join(root, "tasks", `${name}.json`), { name, prompt: `Return OK for ${name}.`, fixture: `fixtures/${name}`, timeoutMs: 8000,
      checks: [{ kind: "output-contains", text: "OK" }] });
  }
  writeJson(path.join(root, "bench-suites", "demo.json"), { name: "demo", tasks: ["alpha", { name: "beta", timeoutMs: 9000 }], targets: ["agent-a", "agent-b"], repeat: 2, concurrency: 2 });
  return result;
}
function processResult(stdout: string, exitCode = 0): ProcessResult {
  return { stdout, stderr: "", exitCode, signal: null, timedOut: false, error: null, latencyMs: 1 };
}
function completed(): string {
  return [{ type: "thread.started", thread_id: "thread-test" },
    { type: "item.completed", item: { type: "agent_message", text: "OK" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }].map((event) => JSON.stringify(event)).join("\n");
}

test("suite dry-run resolves all plans without credentials, processes or writes; timeout precedence is explicit", async () => {
  const { root, env } = lab();
  rmSync(path.join(root, "data"), { recursive: true });
  try {
    await withEnvAsync({ ...env, TEST_KEY: undefined }, async () => {
      assert.deepEqual(listBenchSuites(root), ["demo"]);
      const definition = loadBenchSuiteDefinition(root, "demo");
      assert.equal(definition.tasks[1]?.timeoutMs, 9000);
      const input = loadBenchSuite(root, "demo");
      assert.deepEqual(input.tasks.map((task) => task.timeoutMs), [8000, 9000]);
      const plan = describeBenchSuite(root, input);
      assert.match(JSON.stringify(plan), /responses/u);
      assert.equal(existsSync(path.join(root, "data")), false);
      const overridden = loadBenchSuite(root, "demo", { repeat: 1, concurrency: 4, timeoutMs: 10_000 });
      assert.deepEqual(overridden.tasks.map((task) => task.timeoutMs), [10_000, 10_000]);
      assert.equal(overridden.repeat, 1);
      assert.equal(overridden.concurrency, 4);
      assert.equal(loadTask(root, "alpha").timeoutMs, 8000);
      assert.throws(() => suiteDir(root, "../sessions"), /无效/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite preflight rejects an incompatible later task and invalid definitions before creating any data", async () => {
  const { root, env } = lab();
  rmSync(path.join(root, "data"), { recursive: true });
  try {
    await withEnvAsync(env, async () => {
      writeJson(path.join(root, "tasks", "beta.json"), { name: "beta", prompt: "Edit files.", requires: "workspace-write", checks: [] });
      writeJson(path.join(root, "bench-suites", "bad.json"), { name: "bad", tasks: ["alpha", "beta"], targets: ["direct"] });
      const input = loadBenchSuite(root, "bad");
      assert.throws(() => describeBenchSuite(root, input), /workspace-write/u);
      await assert.rejects(runBenchSuite(root, input, { runProcess: () => { throw new Error("must not run"); } }), /workspace-write/u);
      assert.equal(existsSync(path.join(root, "data")), false);
      for (const values of [{ tasks: [] }, { targets: ["direct", "direct"] }, { repeat: 0 }, { concurrency: 1.5 }, { timeoutMs: -1 }, { tasks: ["../alpha"] }]) {
        writeJson(path.join(root, "bench-suites", "bad.json"), { name: "bad", tasks: ["alpha"], targets: ["direct"], ...values });
        assert.throws(() => loadBenchSuite(root, "bad"));
      }
      assert.equal(existsSync(path.join(root, "data")), false);
      assert.throws(() => describeBenchmark(root, { task: loadTask(root, "beta"), targets: [resolveTarget(root, "direct")], repeat: 1, concurrency: 1 }), /workspace-write/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite freezes every fixture first, shares one concurrency pool and preserves failures without retries", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      let active = 0;
      let maxActive = 0;
      let calls = 0;
      const starts: string[] = [];
      const workspaces = new Set<string>();
      const homes = new Set<string>();
      const input = loadBenchSuite(root, "demo", { timeoutMs: 11_000 });
      const runProcess: ProcessRunner = async (request) => {
        if (request.args[0] === "--version") return processResult("codex-test 1.0");
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls += 1;
        const call = calls;
        workspaces.add(request.cwd);
        homes.add(request.env?.HOME ?? "");
        const content = readFileSync(path.join(request.cwd, "input.txt"), "utf8");
        assert.ok(content === "alpha original" || content === "beta original");
        // Even a source modified before beta is dispatched cannot affect any frozen sample.
        writeFileSync(path.join(root, "fixtures", "beta", "input.txt"), "changed by first running task");
        assert.ok(request.timeoutMs <= 11_000);
        assert.ok(request.timeoutMs > 10_000);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return call === 1 ? processResult('{"type":"turn.failed","error":{"message":"one planned failure"}}', 1) : processResult(completed());
      };
      const result = await runBenchSuite(root, input, { runProcess, onProgress: (message) => {
        if (message.endsWith("开始")) starts.push(message);
      } });
      assert.equal(result.state.status, "completed");
      assert.equal(result.state.completed, 8);
      assert.equal(result.failed, true);
      assert.equal(calls, 8);
      assert.equal(maxActive, 2);
      assert.equal(active, 0);
      assert.equal(workspaces.size, 8);
      assert.equal(homes.size, 8);
      assert.deepEqual(result.spec.schedule.slice(0, 4).map((job) => `${job.task}/${job.target}/${String(job.sample)}`), ["alpha/agent-a/1", "beta/agent-b/1", "alpha/agent-b/1", "beta/agent-a/1"]);
      assert.deepEqual(starts, result.spec.schedule.map((job) => `${job.task} / ${job.target} / ${String(job.sample)} 开始`));
      assert.deepEqual(result.benchmarks.flatMap((benchmark) => benchmark.records).map((record) => record.grade.status).sort(), ["not-run", "passed", "passed", "passed", "passed", "passed", "passed", "passed"]);
      for (const benchmark of result.benchmarks) {
        assert.equal(benchmark.spec.schemaVersion, 1);
        assert.equal(benchmark.spec.task.timeoutMs, 11_000);
        assert.equal(readBenchmark(root, benchmark.spec.id).records.length, 4);
        assert.ok(existsSync(path.join(benchmark.dir, "report.md")));
      }
      const frozenBeta = result.benchmarks.find((benchmark) => benchmark.spec.task.name === "beta");
      assert.ok(frozenBeta);
      assert.equal(readFileSync(path.join(frozenBeta.dir, "fixture", "input.txt"), "utf8"), "beta original");
      assert.equal(loadTask(root, "alpha").timeoutMs, 8000);
      const stored = readBenchSuite(root, result.spec.id);
      assert.deepEqual(stored.spec, result.spec);
      assert.deepEqual(stored.state, result.state);
      assert.equal(listBenchSuiteRuns(root).entries.length, 1);
      assert.deepEqual(listBenchSuiteRuns(root).warnings, []);
      assert.doesNotMatch(JSON.stringify(result), /sk-test-abc/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite missing samples remain missing on interruption, and stored scheduling is validated", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      const result = await runBenchSuite(root, loadBenchSuite(root, "demo", { repeat: 1 }), {
        onProgress: () => { throw new Error("output unavailable sk-test-abc"); },
        runProcess: () => { throw new Error("must not run"); },
      });
      assert.equal(result.failed, true);
      assert.equal(result.state.status, "interrupted");
      assert.equal(result.state.completed, 0);
      assert.equal(result.state.total, 4);
      assert.equal(result.benchmarks.flatMap((entry) => entry.records).length, 0);
      assert.doesNotMatch(JSON.stringify(result.state), /sk-test-abc/u);
      for (const entry of result.benchmarks) assert.equal(readBenchmark(root, entry.spec.id).records.length, 0);
      rmSync(path.join(result.dir, "state.json"));
      assert.equal(readBenchSuite(root, result.spec.id).state.status, "incomplete");
      writeJson(path.join(result.dir, "spec.json"), { ...result.spec, schedule: [result.spec.schedule[0], result.spec.schedule[0]] });
      assert.throws(() => readBenchSuite(root, result.spec.id), /调度/u);
      assert.equal(listBenchSuiteRuns(root).warnings.length, 1);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy single-task schema 1 dispatch and readback remain compatible", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      const target = resolveTarget(root, "direct");
      const result = await runBenchmark(root, { task: loadTask(root, "alpha"), targets: [target], repeat: 2, concurrency: 1 }, {
        complete: createFakeCompleter({}, { text: "OK" }).complete,
      });
      assert.equal(result.failed, false);
      assert.deepEqual(result.records.map((record) => record.sample), [1, 2]);
      assert.equal(readBenchmark(root, result.spec.id).spec.schemaVersion, 1);
      assert.equal(readBenchmark(root, result.spec.id).records.length, 2);
      assert.equal(listBenchSuiteRuns(root).entries.length, 0);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
