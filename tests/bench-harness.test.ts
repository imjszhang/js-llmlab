import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { parseHarnessOutput, planHarness } from "../src/lib/bench/harness.ts";
import type { HarnessAdapter, ProcessResult, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";

function target(adapter: HarnessAdapter, permission: "read-only" | "workspace-write" = "workspace-write"): ResolvedHarnessTarget {
  const protocol = adapter === "claude-code" ? "anthropic-messages" : "responses";
  return { name: adapter, kind: "harness", definition: { name: adapter, kind: "harness", harness: adapter, backend: { provider: "test", model: "test-model", protocol } }, profile: { name: adapter, adapter, executable: adapter === "claude-code" ? "claude" : "codex", permission }, backend: { provider: "test", model: "test-model", protocol, baseURL: "https://backend.test/v1", apiKeyEnv: "TEST_KEY" } };
}
const context = { home: path.resolve("data/tmp/isolated-home"), workspace: path.resolve("data/tmp/task-workspace"), prompt: "Fix it\nwith these instructions", timeoutMs: 30000 };
function output(events: unknown[], overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n", stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 10, ...overrides };
}

test("Claude invocation uses isolated settings, explicit Messages route and stdin without leaking a dry-run secret", () => {
  const plan = planHarness(target("claude-code"), context);
  assert.equal(plan.route, "anthropic-messages");
  assert.equal(plan.process.stdin, context.prompt);
  assert.equal(plan.process.cwd, context.workspace);
  assert.equal(plan.process.env?.HOME, context.home);
  assert.equal(plan.process.env?.CLAUDE_CONFIG_DIR, path.join(context.home, "claude"));
  assert.equal(plan.process.env?.ANTHROPIC_BASE_URL, "https://backend.test");
  assert.equal(plan.process.env?.ANTHROPIC_API_KEY, undefined);
  assert.ok(plan.process.args.includes("--bare"));
  assert.ok(plan.process.args.includes("--safe-mode"));
  assert.ok(plan.process.args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(plan.process.args[plan.process.args.indexOf("--mcp-config") + 1] ?? ""), { mcpServers: {} });
  assert.ok(plan.process.args.includes("--disable-slash-commands"));
  assert.ok(plan.process.args.includes("dontAsk"));
  assert.equal(plan.process.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(plan.process.args.includes("--add-dir"), false);
  assert.ok(plan.files.every((file) => path.isAbsolute(file.path) && file.path.startsWith(context.home + path.sep)));
  assert.deepEqual(JSON.parse(plan.files[0]?.content ?? ""), { disableAllHooks: true, permissions: { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [], credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }] } } });
  assert.equal(planHarness(target("claude-code"), context, "selected-secret").process.env?.ANTHROPIC_API_KEY, "selected-secret");
});

test("read-only Claude profile has no shell or write tools", () => {
  const plan = planHarness(target("claude-code", "read-only"), context);
  assert.equal(plan.process.args[plan.process.args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(plan.process.args[plan.process.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
});

test("Codex invocation explicitly selects Responses provider and isolated API-key auth", () => {
  const plan = planHarness(target("codex", "read-only"), context);
  const args = plan.process.args;
  assert.equal(plan.route, "responses");
  assert.equal(plan.process.env?.CODEX_HOME, path.join(context.home, "codex"));
  assert.equal(plan.process.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes('model_providers.js_llmlab.wire_api="responses"'));
  assert.ok(args.includes('model_providers.js_llmlab.env_key="JS_LLMLAB_HARNESS_API_KEY"'));
  assert.ok(args.includes("model_providers.js_llmlab.requires_openai_auth=false"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes("project_doc_max_bytes=0"));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes(`projects.${JSON.stringify(context.workspace)}.trust_level="untrusted"`));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args.at(-1), "-");
  assert.equal(planHarness(target("codex"), context, "selected-secret").process.env?.JS_LLMLAB_HARNESS_API_KEY, "selected-secret");
});

test("harness plan rejects incompatible protocols without silently bridging them", () => {
  const claude = target("claude-code");
  claude.backend.protocol = "responses";
  assert.throws(() => planHarness(claude, context), /anthropic-messages/u);
  const codex = target("codex");
  codex.backend.protocol = "anthropic-messages";
  assert.throws(() => planHarness(codex, context), /responses/u);
});

test("Claude parser captures aggregate usage/cost and terminal text without double counting per-message usage", () => {
  const result = parseHarnessOutput("claude-code", output([
    { type: "system", subtype: "init", session_id: "session-1", model: "actual-model" },
    { type: "assistant", message: { model: "actual-model", usage: { input_tokens: 999, output_tokens: 999 }, content: [{ type: "thinking", thinking: "plan" }, { type: "tool_use", name: "Read", id: "t1" }, { type: "text", text: "intermediate" }] } },
    { type: "future_event", arbitrary: true },
    { type: "result", subtype: "success", is_error: false, result: "Fixed", session_id: "session-1", usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 7 }, total_cost_usd: 0.023, modelUsage: { "actual-model": { inputTokens: 10 } } },
  ]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Fixed");
  assert.equal(result.reasoning, "plan");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.responseModel, "actual-model");
  assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25, reasoningTokens: null, promptCacheHitTokens: 7, promptCacheMissTokens: 13 });
  assert.deepEqual(result.cost, { input: null, output: null, total: 0.023, currency: "USD" });
  assert.equal(result.events.filter((event) => event.type === "tool").length, 1);
  assert.equal(result.events.filter((event) => event.type === "raw").length, 4);
});

test("harness parsers preserve unknown usage and costs as null", () => {
  const claude = parseHarnessOutput("claude-code", output([{ type: "result", subtype: "success", result: "ok" }]));
  assert.equal(claude.usage, null);
  assert.equal(claude.cost, null);
  const codex = parseHarnessOutput("codex", output([{ type: "item.completed", item: { type: "agent_message", text: "done" } }, { type: "turn.completed" }]));
  assert.equal(codex.status, "completed");
  assert.equal(codex.usage, null);
  assert.equal(codex.cost, null);
  assert.equal(codex.responseModel, null);
});

test("Codex parser separates tools and final answer and uses terminal cumulative usage", () => {
  const result = parseHarnessOutput("codex", output([
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0 } },
    { type: "item.completed", item: { type: "reasoning", text: "checking" } },
    { type: "item.completed", item: { type: "agent_message", text: "Fixed parser" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 30 } },
  ]));
  assert.equal(result.status, "completed");
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.text, "Fixed parser");
  assert.equal(result.reasoning, "checking");
  assert.deepEqual(result.usage, { promptTokens: 100, completionTokens: 30, totalTokens: 130, reasoningTokens: null, promptCacheHitTokens: 70 });
  assert.equal(result.events.filter((event) => event.type === "tool").length, 1);
});

test("parsers reject truncated streams, malformed events, terminal failures and process failure", () => {
  for (const adapter of ["claude-code", "codex"] as const) {
    assert.equal(parseHarnessOutput(adapter, output([])).status, "failed");
    const terminal = adapter === "codex" ? { type: "turn.completed" } : { type: "result", subtype: "success" };
    assert.equal(parseHarnessOutput(adapter, output([terminal], { stdout: "not-json\n" + JSON.stringify(terminal) })).status, "failed");
    assert.equal(parseHarnessOutput(adapter, output([terminal], { exitCode: 2 })).status, "failed");
    assert.equal(parseHarnessOutput(adapter, output([terminal], { error: "output limit" })).status, "failed");
    assert.equal(parseHarnessOutput(adapter, output([terminal], { timedOut: true })).status, "timeout");
  }
  const claude = parseHarnessOutput("claude-code", output([{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["turn limit"] }]));
  assert.equal(claude.status, "failed");
  assert.match(claude.error ?? "", /turn limit/u);
  const codex = parseHarnessOutput("codex", output([{ type: "turn.failed", error: { message: "backend unavailable" } }]));
  assert.equal(codex.status, "failed");
  assert.match(codex.error ?? "", /backend unavailable/u);
  assert.equal(parseHarnessOutput("codex", output([{ type: "error", message: "bad" }, { type: "turn.completed" }])).status, "failed");
});
