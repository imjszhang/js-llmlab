import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runBench, runBenchLs, runBenchShow } from "../src/commands/bench.ts";
import { loadTask, resolveTarget } from "../src/lib/bench/config.ts";
import { runBenchmark } from "../src/lib/bench/runner.ts";
import { benchmarkDir, readBenchmark } from "../src/lib/bench/store.ts";
import type { ProcessResult, ProcessRunner } from "../src/lib/bench/types.ts";
import { createFakeCompleter, throwingCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson, writeText } from "./helpers.ts";

function lab(): ReturnType<typeof makeCommandLab> {
  const result = makeCommandLab();
  const { root } = result;
  writeJson(path.join(root, "providers", "test.json"), { name: "test", baseURL: "https://example.test/v1", model: "demo", apiKeyEnv: "TEST_KEY", maxRetries: 0,
    endpoints: { responses: "https://example.test/v1" } });
  writeJson(path.join(root, "harnesses", "codex.json"), { name: "codex", adapter: "codex", executable: "fake-codex", permission: "workspace-write" });
  writeJson(path.join(root, "targets", "direct.json"), { name: "direct", kind: "llm", config: "a" });
  writeJson(path.join(root, "targets", "agent.json"), { name: "agent", kind: "harness", harness: "codex", backend: { provider: "test", model: "demo", protocol: "responses" } });
  writeText(path.join(root, "fixtures", "demo", "input.txt"), "original");
  writeJson(path.join(root, "tasks", "demo.json"), { name: "demo", prompt: "Return OK.", fixture: "fixtures/demo", timeoutMs: 5000,
    checks: [{ kind: "output-contains", text: "OK" }, { kind: "file-exists", path: "input.txt" }] });
  return result;
}

function processResult(stdout: string, exitCode = 0): ProcessResult {
  return { stdout, stderr: "", exitCode, signal: null, timedOut: false, error: null, latencyMs: 1 };
}

function completed(text = "OK"): string {
  return [{ type: "thread.started", thread_id: "thread-test" },
    { type: "item.completed", item: { type: "agent_message", text } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } }].map((event) => JSON.stringify(event)).join("\n");
}

test("bench dry-run needs no key, executable or data writes, and prints both execution plans", async () => {
  const { root, env } = lab();
  rmSync(path.join(root, "data"), { recursive: true });
  try {
    await withEnvAsync({ ...env, TEST_KEY: undefined }, async () => {
      const logs: string[] = [];
      const result = await runBench({ task: "demo", targets: "direct,agent,direct", dryRun: true }, {
        root, log: (text) => logs.push(text), complete: throwingCompleter(),
        runProcess: () => { throw new Error("不应启动进程"); },
      });
      assert.equal(result, null);
      const plan = JSON.parse(logs[0] ?? "{}");
      assert.equal(plan.targets.length, 2);
      assert.equal(plan.targets[0].request.model, "model-a");
      assert.equal(plan.targets[1].plan.route, "responses");
      assert.equal(plan.targets[1].plan.process.env.JS_LLMLAB_HARNESS_API_KEY, undefined);
      assert.equal(existsSync(path.join(root, "data")), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bench repeats share a frozen fixture but have independent workspaces/home; output order is stable", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      const workspaces = new Set<string>();
      const homes = new Set<string>();
      let mainCalls = 0;
      const runProcess: ProcessRunner = async (request) => {
        if (request.args[0] === "--version") return processResult("codex-test 1.0");
        mainCalls += 1;
        workspaces.add(request.cwd);
        homes.add(request.env?.HOME ?? "");
        assert.equal(readFileSync(path.join(request.cwd, "input.txt"), "utf8"), "original");
        writeFileSync(path.join(request.cwd, "input.txt"), "changed");
        // Changing the source during a run must not change subsequent samples.
        writeFileSync(path.join(root, "fixtures", "demo", "input.txt"), "source changed later");
        return processResult(completed());
      };
      const result = await runBenchmark(root, { task: loadTask(root, "demo"), targets: [resolveTarget(root, "agent"), resolveTarget(root, "direct")], repeat: 2, concurrency: 1 },
        { runProcess, complete: createFakeCompleter({}, { text: "OK" }).complete });
      assert.equal(result.failed, false);
      assert.equal(mainCalls, 2);
      assert.equal(workspaces.size, 2);
      assert.equal(homes.size, 2);
      assert.deepEqual(result.records.map((record) => `${record.target.name}:${String(record.sample)}`), ["agent:1", "agent:2", "direct:1", "direct:2"]);
      assert.deepEqual(result.records.map((record) => record.grade.status), ["passed", "passed", "passed", "passed"]);
      assert.equal(result.records[0]?.changes[0]?.kind, "modified");
      assert.equal(result.records[2]?.changes.length, 0);
      assert.equal(readFileSync(path.join(result.dir, "fixture", "input.txt"), "utf8"), "original");
      assert.equal(readBenchmark(root, result.spec.id).records.length, 4);
      assert.ok(existsSync(path.join(result.dir, "variants", "agent", "run-2", "events.jsonl")));
      const report = readFileSync(path.join(result.dir, "report.md"), "utf8");
      assert.match(report, /codex-test 1\.0/u);
      assert.match(report, /Fixture SHA-256/u);
      assert.doesNotMatch(report, /sk-test-abc/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bench isolates failed executions and failed acceptance, preserving raw output and redacting keys", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      const result = await runBench({ task: "demo", targets: "agent,direct", concurrency: "2" }, {
        root, log: () => {}, error: () => {}, complete: createFakeCompleter({}, { text: "wrong answer sk-test-abc" }).complete,
        runProcess: async (request) => request.args[0] === "--version" ? processResult("fake 1.0")
          : { ...processResult('{"type":"turn.failed","error":{"message":"sk-test-abc failed"}}', 1), stderr: "sk-test-abc" },
      });
      assert.ok(result);
      assert.equal(result.failed, true);
      assert.equal(result.records[0]?.execution.status, "failed");
      assert.equal(result.records[0]?.grade.status, "not-run");
      assert.equal(result.records[1]?.execution.status, "completed");
      assert.equal(result.records[1]?.grade.status, "failed");
      assert.doesNotMatch(JSON.stringify(result), /sk-test-abc/u);
      const stored = readFileSync(path.join(result.dir, "variants", "agent", "run-1", "record.json"), "utf8");
      assert.doesNotMatch(stored, /sk-test-abc/u);
      assert.match(stored, /turn.failed/u);
      const logs: string[] = [];
      runBenchLs({ root, log: (text) => logs.push(text) });
      runBenchShow(result.spec.id, { root, log: (text) => logs.push(text) });
      assert.match(logs.join("\n"), new RegExp(result.spec.id, "u"));
      assert.throws(() => benchmarkDir(root, "../sessions"), /无效/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bench invalid protocol routes fail before any experiment is created", async () => {
  const { root, env } = lab();
  writeJson(path.join(root, "targets", "bad.json"), { name: "bad", kind: "harness", harness: "codex", backend: { provider: "test", model: "demo", protocol: "anthropic-messages" } });
  try {
    await withEnvAsync(env, async () => {
      await assert.rejects(runBench({ task: "demo", targets: "bad" }, { root, complete: throwingCompleter() }), /responses/u);
      assert.deepEqual(readdirSync(path.join(root, "data")), []);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bench validates orchestration arguments before writing and dry-run redacts echoed credentials", async () => {
  const { root, env } = lab();
  try {
    await withEnvAsync(env, async () => {
      const target = resolveTarget(root, "direct");
      const input = { task: loadTask(root, "demo"), targets: [target], repeat: 1, concurrency: 1 };
      for (const invalid of [{ repeat: 0 }, { concurrency: 0 }, { targets: [target, target] }]) {
        await assert.rejects(runBenchmark(root, { ...input, ...invalid }), /安全整数|重复/u);
      }
      assert.deepEqual(readdirSync(path.join(root, "data")), []);
      writeJson(path.join(root, "tasks", "secret.json"), { name: "secret", prompt: "echo sk-test-abc", checks: [] });
      const logs: string[] = [];
      await runBench({ task: "secret", targets: "direct", dryRun: true }, { root, log: (text) => logs.push(text) });
      assert.doesNotMatch(logs.join(""), /sk-test-abc/u);
      assert.match(logs.join(""), /echo \*\*\*/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bench attributes file changes before checker-generated files", async () => {
  const { root, env } = lab();
  writeJson(path.join(root, "tasks", "check.json"), { name: "check", prompt: "Write output.txt.", checks: [{ kind: "command", argv: ["fake-check"] }] });
  try {
    await withEnvAsync(env, async () => {
      const result = await runBench({ task: "check", targets: "agent" }, {
        root, log: () => {}, error: () => {}, runProcess: async (request) => {
          if (request.args[0] === "--version") return processResult("fake 1.0");
          if (request.executable === "fake-check") {
            writeFileSync(path.join(request.cwd, "checker.log"), "checker generated");
            return processResult("");
          }
          writeFileSync(path.join(request.cwd, "output.txt"), "target generated");
          return processResult(completed());
        },
      });
      assert.ok(result);
      assert.deepEqual(result.records[0]?.changes.map((change) => change.path), ["output.txt"]);
      assert.equal(result.records[0]?.grade.status, "passed");
      assert.ok(existsSync(path.join(result.records[0]?.workspace ?? "", "checker.log")));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
