import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTarget } from "../src/lib/bench/executor.ts";
import type { ExecutionInput, HarnessAdapter, ProcessRequest, ProcessResult, ResolvedHarnessTarget, ResolvedLlmTarget } from "../src/lib/bench/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { withEnvAsync } from "./helpers.ts";

function llm(): ResolvedLlmTarget {
  return {
    name: "direct", kind: "llm", definition: { name: "direct", kind: "llm", config: "demo" },
    apiKeyEnv: "BENCH_TEST_API_KEY", systemText: "A system instruction.",
    config: {
      name: "demo", provider: "llm-provider", baseURL: "https://example.test/v1", model: "demo-model",
      temperature: 1, maxTokens: 100, thinking: null, reasoningEffort: null, timeoutMs: 5000, maxRetries: 0,
      pricing: { inputPerMillion: 1, outputPerMillion: 2, currency: "CNY" },
    },
  };
}

function harness(adapter: HarnessAdapter): ResolvedHarnessTarget {
  const protocol = adapter === "codex" ? "responses" : adapter === "opencode" ? "chat-completions" : "anthropic-messages";
  return {
    name: `test-${adapter}`, kind: "harness",
    definition: {
      name: `test-${adapter}`, kind: "harness", harness: adapter,
      backend: { provider: "independent-service", model: "backend-model", protocol },
    },
    profile: { name: adapter, adapter, executable: `/fake/${adapter}`, permission: "workspace-write" },
    backend: {
      provider: "independent-service", model: "backend-model", protocol,
      baseURL: "https://backend.test/v1", apiKeyEnv: "BENCH_TEST_API_KEY",
    },
  };
}

function processResult(stdout: string, extras: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1, ...extras };
}

async function input(target: ExecutionInput["target"] = llm()): Promise<ExecutionInput> {
  const root = await mkdtemp(path.join(tmpdir(), "llmlab-executor-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  return { root, target, workspace, home: path.join(root, "home"), task: { name: "demo-task", prompt: "Solve the task.", timeoutMs: 1000, checks: [] } };
}

test("direct executor uses snapshot backend, system and prompt and preserves raw/usage/cost", async () => {
  const context = await input();
  const fake = createFakeCompleter({ demo: { text: "answer", reasoning: "reason", responseModel: "resolved-model" } });
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { complete: fake.complete });
      assert.equal(result.status, "completed");
      assert.equal(result.text, "answer");
      assert.equal(result.responseModel, "resolved-model");
      assert.equal(result.usageSource, "request");
      assert.equal(result.costSource, "configured-pricing");
      assert.ok(result.cost !== null);
      assert.ok(result.raw !== null);
      const call = fake.calls[0];
      assert.ok(call !== undefined);
      assert.equal(call.config.provider, "llm-provider");
      assert.equal(call.config.apiKey, "fake-executor-secret");
      assert.deepEqual(call.messages, [{ role: "system", content: "A system instruction." }, { role: "user", content: "Solve the task." }]);
      assert.ok(call.options.signal instanceof AbortSignal);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("direct executor missing credentials fails without calling the completer", async () => {
  const context = await input();
  const fake = createFakeCompleter();
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: undefined }, async () => {
      const result = await executeTarget(context, { complete: fake.complete });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /BENCH_TEST_API_KEY/u);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("direct executor omits empty system text consistently with dry-run", async () => {
  const context = await input();
  if (context.target.kind !== "llm") throw new Error("Expected llm");
  context.target.systemText = "";
  const fake = createFakeCompleter();
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      await executeTarget(context, { complete: fake.complete });
      assert.deepEqual(fake.calls[0]?.messages, [{ role: "user", content: context.task.prompt }]);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("direct executor enforces wallclock timeout even when fake completion ignores abort", async () => {
  const context = await input();
  context.task.timeoutMs = 20;
  const fake = createFakeCompleter({}, { delayMs: 100, failTimes: 1 });
  if (context.target.kind !== "llm") throw new Error("Expected llm");
  context.target.config.maxRetries = 5;
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const started = Date.now();
      const result = await executeTarget(context, { complete: fake.complete });
      assert.equal(result.status, "timeout");
      assert.ok(Date.now() - started < 100);
      assert.equal(fake.calls[0]?.options.signal?.aborted, true);
      await new Promise((resolve) => setTimeout(resolve, 110));
      assert.equal(fake.calls.length, 1);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("direct executor cancels backoff and does not retry after task budget", async () => {
  const context = await input();
  context.task.timeoutMs = 30;
  if (context.target.kind !== "llm") throw new Error("Expected llm");
  context.target.config.maxRetries = 3;
  const fake = createFakeCompleter({}, { failTimes: 1 });
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { complete: fake.complete });
      assert.equal(result.status, "timeout");
      assert.equal(fake.calls.length, 1);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("direct executor does not turn unknown usage into zero and redacts nested raw/errors", async () => {
  const context = await input();
  const own = "fake-own-secret";
  const other = "fake-other-secret";
  const fake = createFakeCompleter({}, { text: `${own} / ${other}`, usage: null });
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: own, OTHER_BACKEND_API_KEY: other }, async () => {
      const result = await executeTarget(context, { complete: fake.complete });
      assert.equal(result.usage, null);
      assert.equal(result.cost, null);
      assert.equal(result.costSource, null);
      assert.equal(result.text, "*** / ***");
      assert.ok(!JSON.stringify(result).includes(own));
      assert.ok(!JSON.stringify(result).includes(other));
      const failure = createFakeCompleter({}, { failTimes: 1, error: `${own} ${other}` });
      const failed = await executeTarget(context, { complete: failure.complete });
      assert.equal(failed.status, "failed");
      assert.ok(!JSON.stringify(failed).includes(own));
      assert.ok(!JSON.stringify(failed).includes(other));
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("Claude Code probes then executes isolated plan and preserves run totals and events", async () => {
  const context = await input(harness("claude-code"));
  const requests: ProcessRequest[] = [];
  const output = JSON.stringify({ type: "result", subtype: "success", result: "finished", session_id: "session-1", usage: { input_tokens: 12, output_tokens: 6 }, total_cost_usd: 0.02 });
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { runProcess: async (request) => {
        requests.push(request);
        if (requests.length === 1) return processResult("Claude Code test-version\n");
        assert.match(await readFile(path.join(context.home, "claude", "settings.json"), "utf8"), /disableAllHooks/u);
        return processResult(output);
      } });
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0]?.args, ["--version"]);
      assert.equal(requests[0]?.env?.ANTHROPIC_API_KEY, undefined);
      assert.equal(requests[0]?.env?.HOME, requests[1]?.env?.HOME);
      assert.equal(requests[1]?.env?.ANTHROPIC_API_KEY, "fake-executor-secret");
      assert.equal(requests[1]?.stdin, context.task.prompt);
      assert.equal(result.status, "completed");
      assert.equal(result.harnessVersion, "Claude Code test-version");
      assert.equal(result.sessionId, "session-1");
      assert.equal(result.usageSource, "run-total");
      assert.equal(result.costSource, "harness-reported");
      assert.ok(result.events.length > 0);
      assert.equal(result.usage?.totalTokens, 18);
      assert.equal(result.cost?.total, 0.02);
      assert.match(JSON.stringify(result.raw), /--output-format/u);
      assert.match(JSON.stringify(result.raw), /"route":"anthropic-messages"/u);
      assert.match(JSON.stringify(result.raw), /"ANTHROPIC_API_KEY":"\*\*\*"/u);
      assert.ok(!JSON.stringify(result).includes("fake-executor-secret"));
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("Codex backend stays independent from harness and raw/event streams are redacted", async () => {
  const context = await input(harness("codex"));
  const requests: ProcessRequest[] = [];
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret", OTHER_BACKEND_API_KEY: "fake-other-secret" }, async () => {
      const result = await executeTarget(context, { runProcess: async (request) => {
        requests.push(request);
        if (requests.length === 1) return processResult("codex version");
        return processResult([
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fake-executor-secret fake-other-secret" } }),
          JSON.stringify({ type: "turn.completed" }),
        ].join("\n"), { stderr: "fake-executor-secret" });
      } });
      assert.equal(result.status, "completed");
      assert.equal(result.usage, null);
      assert.equal(result.cost, null);
      assert.equal(result.text, "*** ***");
      assert.equal(result.sessionId, "thread-1");
      assert.equal(requests[1]?.env?.JS_LLMLAB_HARNESS_API_KEY, "fake-executor-secret");
      assert.ok(requests[1]?.args.includes("backend-model"));
      assert.ok(!JSON.stringify(result).includes("fake-executor-secret"));
      assert.ok(!JSON.stringify(result).includes("fake-other-secret"));
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("harness probe errors stop execution and do not retry", async () => {
  for (const failure of [
    processResult("", { error: "ENOENT fake-executor-secret", exitCode: null }),
    processResult("", { timedOut: true, exitCode: null }),
    processResult("invalid", { exitCode: 2 }),
  ]) {
    const context = await input(harness("codex"));
    let calls = 0;
    try {
      await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
        const result = await executeTarget(context, { runProcess: async () => { calls += 1; return failure; } });
        assert.equal(result.status, failure.timedOut ? "timeout" : "failed");
        assert.equal(calls, 1);
        assert.ok(!JSON.stringify(result).includes("fake-executor-secret"));
      });
    } finally { await rm(context.root, { recursive: true, force: true }); }
  }
});

test("OpenCode inspection failure or timeout prevents success even after a normal main process", async () => {
  for (const inspection of [
    processResult("", { exitCode: 1, stderr: "cannot export" }),
    processResult("", { timedOut: true, error: "inspection deadline", exitCode: null }),
    processResult("not JSON"),
  ]) {
    const context = await input(harness("opencode"));
    let calls = 0;
    try {
      await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
        const result = await executeTarget(context, { runProcess: async (request) => {
          calls += 1;
          if (request.args[0] === "--version") return processResult("opencode v2.0.32");
          if (request.args[0] === "session") {
            assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
            assert.ok(request.timeoutMs <= context.task.timeoutMs);
            return inspection;
          }
          return processResult(JSON.stringify({ type: "text", sessionID: "ses_test", part: { id: "part", messageID: "msg_test", text: "OK" } }));
        } });
        assert.equal(calls, 3);
        assert.equal(result.status, inspection.timedOut ? "timeout" : "failed");
        assert.equal(result.usage, null);
        assert.match(JSON.stringify(result.raw), /inspection/u);
        assert.ok(result.error !== null);
      });
    } finally { await rm(context.root, { recursive: true, force: true }); }
  }
});

test("OpenCode inspection shares the task budget and cannot start after its expiry", async () => {
  const context = await input(harness("opencode"));
  context.task.timeoutMs = 200;
  let calls = 0;
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { runProcess: async (request) => {
        calls += 1;
        if (request.args[0] === "--version") return processResult("opencode v2.0.32");
        assert.equal(request.args[0], "run");
        // An injected runner may return only after its own asynchronous cleanup.
        await new Promise((resolve) => setTimeout(resolve, 220));
        return processResult(JSON.stringify({ type: "text", sessionID: "ses_test", part: { id: "part", messageID: "msg_test", text: "OK" } }));
      } });
      assert.equal(calls, 2);
      assert.equal(result.status, "timeout");
      assert.equal(result.text, "OK");
      assert.match(result.error ?? "", /无法核验/u);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("harness task budget includes version probing and execution has no automatic retry", async () => {
  const context = await input(harness("codex"));
  context.task.timeoutMs = 200;
  const requests: ProcessRequest[] = [];
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { runProcess: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return processResult("codex-version");
        }
        return processResult(JSON.stringify({ type: "turn.failed", error: { message: "backend unavailable" } }), { exitCode: 1 });
      } });
      assert.equal(requests.length, 2);
      assert.ok((requests[1]?.timeoutMs ?? 200) < 180);
      assert.equal(result.status, "failed");
      assert.equal(result.harnessVersion, "codex-version");
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("harness waits for timed-out process cleanup and retains partial output", async () => {
  const context = await input(harness("codex"));
  context.task.timeoutMs = 20;
  let calls = 0;
  let cleaned = false;
  try {
    await withEnvAsync({ BENCH_TEST_API_KEY: "fake-executor-secret" }, async () => {
      const result = await executeTarget(context, { runProcess: async () => {
        calls += 1;
        if (calls === 1) return processResult("codex-version");
        await new Promise((resolve) => setTimeout(resolve, 40));
        cleaned = true;
        return processResult(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "partial output" } }), { timedOut: true, exitCode: null, stderr: "partial diagnostic" });
      } });
      assert.equal(result.status, "timeout");
      assert.equal(calls, 2);
      assert.equal(cleaned, true);
      assert.equal(result.stderr, "partial diagnostic");
      assert.match(result.stdout, /partial output/u);
      assert.match(JSON.stringify(result.raw), /partial diagnostic/u);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});
