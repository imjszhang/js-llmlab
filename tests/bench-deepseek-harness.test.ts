import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { parseDeepSeekHarnessOutput, planDeepSeekHarness } from "../src/lib/bench/adapters/deepseek-harness.ts";
import type { ProcessResult, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";

function target(permission: "read-only" | "workspace-write" = "workspace-write"): ResolvedHarnessTarget {
  return {
    name: "dsh-test", kind: "harness",
    definition: { name: "dsh-test", kind: "harness", harness: "deepseek-harness", backend: { provider: "independent-backend", model: "selected-model", protocol: "anthropic-messages" } },
    profile: { name: "deepseek-harness", adapter: "deepseek-harness", executable: "dsh", permission },
    backend: { provider: "independent-backend", model: "selected-model", protocol: "anthropic-messages", baseURL: "https://backend.test/anthropic/", apiKeyEnv: "SELECTED_KEY" },
  };
}
const context = { home: path.resolve("data/tmp/dsh-test-home"), workspace: path.resolve("data/tmp/dsh-test-workspace"), prompt: "A multi-line task\n- with details", timeoutMs: 30000 };
function output(events: unknown[], overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n", stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 10, ...overrides };
}
const session = { type: "session", sessionId: "session-test", cwd: context.workspace };
const completed = { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } };
const final = { type: "final", text: "Task finished\nexactly" };

test("DeepSeek Harness plan isolates a headless native Messages route without writing credentials", () => {
  const originalHome = process.env.HOME;
  const originalDshHome = process.env.DSH_HOME;
  const plan = planDeepSeekHarness(target(), context);
  assert.equal(plan.route, "anthropic-messages");
  assert.deepEqual(plan.process.args, ["--profile", "headless", "--patch", path.join(context.home, "dsh", "bench.patch.yml"), "--json", "-"]);
  assert.equal(plan.process.stdin, context.prompt);
  assert.equal(plan.process.cwd, context.workspace);
  assert.equal(plan.process.timeoutMs, context.timeoutMs);
  assert.equal(plan.process.terminationGraceMs, 4000);
  assert.equal(plan.process.env?.HOME, context.home);
  assert.equal(plan.process.env?.DSH_HOME, path.join(context.home, "dsh"));
  assert.equal(plan.process.env?.AGENTS_HOME, path.join(context.home, "agents"));
  assert.equal(plan.process.env?.GIT_CEILING_DIRECTORIES, context.workspace);
  assert.equal(plan.process.env?.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(plan.process.env?.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(plan.process.env?.OTEL_SDK_DISABLED, "true");
  assert.equal(plan.process.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
  assert.equal(process.env.HOME, originalHome);
  assert.equal(process.env.DSH_HOME, originalDshHome);
  assert.ok(plan.files.every((file) => path.isAbsolute(file.path) && file.path.startsWith(context.home + path.sep)));
  const manifest = JSON.parse(plan.files.find((file) => file.path.endsWith("package.json"))?.content ?? "{}");
  assert.deepEqual(manifest, { private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } });
  const patches: Array<Record<string, unknown>> = JSON.parse(plan.files.find((file) => file.path.endsWith("bench.patch.yml"))?.content ?? "[]");
  assert.deepEqual(patches.find((entry) => entry.id === "llm-deepseek"), { id: "llm-deepseek", config: { baseURL: "https://backend.test/anthropic", apiKeyEnv: "JS_LLMLAB_HARNESS_API_KEY", models: [{ id: "selected-model" }] } });
  assert.deepEqual(patches.find((entry) => entry.id === "agent-default-model"), { id: "agent-default-model", config: { provider: "deepseek-official", model: "selected-model" } });
  assert.deepEqual(patches.find((entry) => entry.id === "sandbox-policy"), { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: context.workspace } });
  assert.deepEqual(patches.find((entry) => entry.id === "approval"), { id: "approval", config: { policy: "never" } });
  assert.deepEqual(patches.find((entry) => entry.id === "permission"), { id: "permission", config: { presets: { "workspace-write": { sandbox: "workspace-write", approval: "never" } }, defaultPreset: "workspace-write" } });
  for (const id of ["agent-instructions", "session-title-llm", "skill-filesystem", "plugin-manager", "otel", "session-telemetry-otel", "tool-subagent", "tool-subagent-fork", "tool-workflow", "tool-web", "llm-deepseek-account", "llm-pi-ai", "credentials"]) {
    assert.deepEqual(patches.find((entry) => entry.id === id), { id, disabled: true });
  }
  const authenticated = planDeepSeekHarness(target(), context, "selected-secret");
  assert.equal(authenticated.process.env?.JS_LLMLAB_HARNESS_API_KEY, "selected-secret");
  assert.equal(JSON.stringify(authenticated.files).includes("selected-secret"), false);
});

test("DeepSeek Harness read-only profile denies mutations and excludes model shell tools", () => {
  const plan = planDeepSeekHarness(target("read-only"), context);
  const patches: Array<Record<string, unknown>> = JSON.parse(plan.files.find((file) => file.path.endsWith("bench.patch.yml"))?.content ?? "[]");
  assert.deepEqual(patches.find((entry) => entry.id === "sandbox-policy"), { id: "sandbox-policy", config: { mode: "read-only", workspaceRoot: context.workspace } });
  assert.deepEqual(patches.find((entry) => entry.id === "tool-bash"), { id: "tool-bash", disabled: true });
  assert.deepEqual(patches.find((entry) => entry.id === "tool-pwsh"), { id: "tool-pwsh", disabled: true });
  const incompatible = target();
  incompatible.backend.protocol = "chat-completions";
  assert.throws(() => planDeepSeekHarness(incompatible, context), /anthropic-messages/u);
});

test("DeepSeek Harness JSON projection needs final and completed turn, aggregates exact per-step usage once", () => {
  const parsed = parseDeepSeekHarnessOutput(output([
    session,
    { type: "status", phase: "turn_start", turn: 1 },
    { type: "thinking", text: "First " },
    { type: "thinking", text: "plan" },
    { type: "text", text: "Intermediate" },
    { type: "tool_call", callId: "call-1", tool: "read", input: { path: "index.ts" } },
    { type: "tool_result", callId: "call-1", status: "error", result: "missing; agent can recover" },
    { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 19, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2 } },
    { type: "future_event", payload: true },
    { type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 5, reasoningTokens: 3 } },
    completed, final,
  ]));
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.error, null);
  assert.equal(parsed.text, final.text);
  assert.equal(parsed.reasoning, "First plan");
  assert.equal(parsed.sessionId, "session-test");
  assert.equal(parsed.responseModel, null);
  assert.equal(parsed.cost, null);
  assert.deepEqual(parsed.usage, { promptTokens: 40, completionTokens: 10, totalTokens: 50, reasoningTokens: 5, promptCacheHitTokens: 8, promptCacheMissTokens: 32 });
  assert.equal(parsed.events.filter((event) => event.type === "tool").length, 2);
  assert.equal(parsed.events.filter((event) => event.type === "usage").length, 2);
  assert.ok(parsed.events.some((event) => event.type === "raw" && JSON.stringify(event.data).includes("future_event")));
});

test("DeepSeek Harness absent or partial usage remains unknown", () => {
  assert.equal(parseDeepSeekHarnessOutput(output([session, completed, final])).usage, null);
  assert.equal(parseDeepSeekHarnessOutput(output([
    session,
    { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4 } },
    { type: "status", phase: "step_end", turn: 1, step: 2 },
    completed, final,
  ])).usage, null);
  const parsed = parseDeepSeekHarnessOutput(output([
    session,
    { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 3 } },
    { type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 20, outputTokens: 6 } },
    completed, final,
  ]));
  assert.deepEqual(parsed.usage, { promptTokens: 33, completionTokens: 10, totalTokens: 43, reasoningTokens: null });
});

test("DeepSeek Harness rejects exit 0 without terminal proof, malformed output, or conflicting terminal states", () => {
  const failures: ProcessResult[] = [
    output([]),
    output([session, { type: "text", text: "looks successful" }]),
    output([session, final]),
    output([session, completed]),
    output([completed, final]),
    output([session, { type: "status", phase: "turn_end", reason: { kind: "aborted" } }, final]),
    output([session, { type: "status", phase: "turn_end", reason: { kind: "error", error: { message: "provider failed" } } }, final]),
    output([session, completed, final, final]),
    output([session, completed, final, completed]),
    output([session, completed, completed, final]),
    output([session, session, completed, final]),
    output([session, { type: "error", message: "driver failed" }, completed, final]),
    output([session, { type: "status", phase: "step_end", turn: 1, step: 1 }, { type: "status", phase: "step_end", turn: 1, step: 1 }, completed, final]),
    output([session, completed, final], { stdout: "not-json\n" + output([session, completed, final]).stdout }),
    output([session, completed, final], { exitCode: 1 }),
    output([session, completed, final], { error: "output exceeded limit" }),
  ];
  for (const result of failures) {
    const parsed = parseDeepSeekHarnessOutput(result);
    assert.equal(parsed.status, "failed", result.stdout);
    assert.notEqual(parsed.error, null);
  }
  const timedOut = parseDeepSeekHarnessOutput(output([session, completed, final], { timedOut: true }));
  assert.equal(timedOut.status, "timeout");
});

test("DeepSeek Harness final closes the stream and cannot be overwritten by trailing text or tool activity", () => {
  for (const event of [{ type: "text", text: "tampered answer" }, { type: "thinking", text: "extra" }, { type: "tool_call", tool: "write" }, { type: "future_event" }]) {
    const parsed = parseDeepSeekHarnessOutput(output([session, completed, final, event]));
    assert.equal(parsed.status, "failed");
    assert.equal(parsed.text, final.text);
    assert.equal(parsed.reasoning, null);
    assert.equal(parsed.usage, null);
  }
});

test("DeepSeek Harness driver errors preserve diagnostics and do not invent terminal output", () => {
  const result = parseDeepSeekHarnessOutput(output([session, { type: "error", message: "Model unavailable" }], { exitCode: 1, stderr: "dsh: Model unavailable\n" }));
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Model unavailable");
  assert.equal(result.text, "");
  assert.equal(result.usage, null);
});
