import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { parseOpenCodeInspection, parseOpenCodeOutput, planOpenCode, planOpenCodeInspection } from "../src/lib/bench/adapters/opencode.ts";
import type { ProcessResult, ResolvedApiKeyHarnessBackend, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";

function target(permission: "read-only" | "workspace-write" = "workspace-write"): ResolvedHarnessTarget & { backend: ResolvedApiKeyHarnessBackend } {
  const backend = { provider: "test", model: "test-model", protocol: "chat-completions" } as const;
  return { name: "opencode-test", kind: "harness", definition: { name: "opencode-test", kind: "harness", harness: "opencode", backend }, profile: { name: "opencode", adapter: "opencode", executable: "opencode", permission }, backend: { ...backend, baseURL: "https://backend.test/v1/", apiKeyEnv: "TEST_KEY" } };
}
const context = { home: path.resolve("data/tmp/opencode-home"), workspace: path.resolve("data/tmp/opencode-workspace"), prompt: "Fix it\nwithout interactive input", timeoutMs: 30000 };
function output(events: unknown[], overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout: events.map((event) => JSON.stringify(event)).join("\n") + "\n", stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 10, ...overrides };
}
function step(id: string, reason = "stop", tokens: unknown = { input: 10, output: 3, reasoning: 2, cache: { read: 7, write: 1 } }) {
  return { type: "step_finish", sessionID: "ses_test", part: { id, type: "step-finish", messageID: `msg_${id}`, reason, tokens, cost: 0 } };
}
function text(id: string, value: string, messageID = `msg_${id}`) {
  return { type: "text", sessionID: "ses_test", part: { id: `text_${id}`, messageID, type: "text", text: value } };
}

test("OpenCode V2 plan uses isolated standalone Chat Completions provider and no on-disk secret", () => {
  const plan = planOpenCode(target(), context, "selected-secret");
  assert.deepEqual(plan.process.args, ["run", "--standalone", "--format", "json", "--thinking", "--model", "js_llmlab/test-model", "--agent", "build"]);
  assert.equal(plan.process.stdin, context.prompt);
  assert.equal(plan.process.terminationGraceMs, 4000);
  assert.equal(plan.process.cwd, context.workspace);
  assert.equal(plan.process.env?.HOME, context.home);
  assert.equal(plan.process.env?.PWD, context.workspace);
  assert.equal(plan.process.env?.GIT_CEILING_DIRECTORIES, context.workspace);
  assert.equal(plan.process.env?.JS_LLMLAB_HARNESS_API_KEY, "selected-secret");
  assert.equal(plan.process.env?.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(plan.process.env?.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(plan.process.env?.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(plan.process.env?.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(plan.route, "chat-completions");
  assert.ok(plan.files.every((file) => path.isAbsolute(file.path) && file.path.startsWith(context.home + path.sep)));
  assert.equal(JSON.stringify(plan.files).includes("selected-secret"), false);
  const config = JSON.parse(plan.files[0]?.content ?? "");
  assert.equal(config.providers.js_llmlab.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(config.providers.js_llmlab.settings.baseURL, "https://backend.test/v1");
  assert.deepEqual(config.providers.js_llmlab.env, ["JS_LLMLAB_HARNESS_API_KEY"]);
  assert.equal(config.providers.js_llmlab.models["test-model"].cost, undefined);
  assert.deepEqual(config.agents.title, { disabled: true });
  assert.deepEqual(config.agents.summary, { disabled: true });
  assert.equal(config.warming, false);
  assert.ok(config.plugins.includes("-opencode.config.instruction"));
  assert.ok(config.plugins.includes("-opencode.config.compatibility"));
  assert.ok(config.policies.some((rule: Record<string, unknown>) => rule.action === "integration.use" && rule.resource === "mcp:*" && rule.effect === "deny"));
  assert.equal(planOpenCode(target(), context).process.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
});

test("OpenCode profiles grant only local read tools, and write profiles add editing and shell", () => {
  const readonly = JSON.parse(planOpenCode(target("read-only"), context).files[0]?.content ?? "");
  const writable = JSON.parse(planOpenCode(target(), context).files[0]?.content ?? "");
  assert.deepEqual(readonly.permissions.filter((rule: Record<string, unknown>) => rule.effect === "allow").map((rule: Record<string, unknown>) => rule.action), ["read", "glob", "grep"]);
  assert.deepEqual(writable.permissions.filter((rule: Record<string, unknown>) => rule.effect === "allow").map((rule: Record<string, unknown>) => rule.action), ["read", "glob", "grep", "edit", "shell"]);
  assert.deepEqual(writable.agents.build.permissions, writable.permissions);
  assert.throws(() => planOpenCode({ ...target(), backend: { ...target().backend, protocol: "responses" } }, context), /requires a chat-completions/u);
});

test("trusted OpenCode plugin removes credentials from shell environment without dependencies", async () => {
  const plugin = planOpenCode(target(), context).files.find((file) => file.path.endsWith("index.mjs"));
  assert.ok(plugin);
  let registered: ((invocation: { env: Record<string, string | undefined> }) => void) | null = null;
  const sandbox = { plugin: null as { setup: (ctx: unknown) => Promise<void> } | null };
  vm.runInNewContext(plugin.content.replace("export default", "plugin ="), sandbox);
  assert.ok(sandbox.plugin);
  await sandbox.plugin.setup({ shell: { hook: async (name: string, hook: (invocation: { env: Record<string, string | undefined> }) => void) => { assert.equal(name, "create.before"); registered = hook; } } });
  assert.ok(registered);
  const ambient = { PATH: "/bin", JS_LLMLAB_HARNESS_API_KEY: "hidden", ANTHROPIC_AUTH_TOKEN: "hidden2", OPENCODE_CONFIG_CONTENT: "hidden3", HOME: "/isolated" };
  const invocation: { env: Record<string, string | undefined> } = { env: { ...ambient } };
  // Hooks are registered by a callback, so narrowing cannot infer the assignment.
  const hooks: Array<(value: typeof invocation) => void> = [];
  if (registered !== null) hooks.push(registered);
  for (const hook of hooks) hook(invocation);
  const childEnv = { ...ambient, ...invocation.env };
  assert.equal(childEnv.JS_LLMLAB_HARNESS_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(childEnv.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(childEnv.PATH, "/bin");
  assert.equal(childEnv.HOME, "/isolated");
});

test("OpenCode sums deduplicated step usage with cache and reasoning, keeping unknown price null", () => {
  const second = step("two");
  const result = parseOpenCodeOutput(output([text("one", "Inspecting"), step("one", "tool-calls"), text("two", "Done"), second, second]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Done");
  assert.equal(result.sessionId, "ses_test");
  assert.equal(result.responseModel, null);
  assert.deepEqual(result.usage, { promptTokens: 36, completionTokens: 10, totalTokens: 46, reasoningTokens: 4, promptCacheHitTokens: 14, promptCacheMissTokens: 22 });
  assert.equal(result.cost, null);
  assert.equal(result.events.filter((event) => event.type === "raw").length, 5);
});

test("OpenCode preserves tool events, reasoning and multiple final text blocks", () => {
  const reasoning = { type: "reasoning", sessionID: "ses_test", part: { id: "reason", messageID: "msg_two", text: "thinking" } };
  const tool = { type: "tool_use", sessionID: "ses_test", part: { id: "call", messageID: "msg_two", tool: "read", state: { status: "completed", output: "file" } } };
  const result = parseOpenCodeOutput(output([tool, reasoning, text("a", "First", "msg_two"), step("two"), text("b", "Second", "msg_two"), { type: "future_event", metadata: true }]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "FirstSecond");
  assert.equal(result.reasoning, "thinking");
  assert.ok(result.events.some((event) => event.type === "tool"));
});

test("OpenCode cannot call incomplete token metadata or parent-only accounting run-total", () => {
  assert.equal(parseOpenCodeOutput(output([step("one", "tool-calls", {}), step("two")])).usage, null);
  const delegated = { type: "tool_use", sessionID: "ses_test", part: { messageID: "msg_two", tool: "subagent", state: { status: "completed" } } };
  assert.equal(parseOpenCodeOutput(output([delegated, step("two")])).usage, null);
  assert.equal(parseOpenCodeOutput(output([step("two", "stop", { input: 1, output: 1, reasoning: 0 })])).usage, null);
});

test("OpenCode final output belongs to the final stop message, even if it has no text", () => {
  const result = parseOpenCodeOutput(output([text("one", "Intermediate commentary"), step("one", "tool-calls"), step("two")]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "");
  assert.ok(result.events.some((event) => event.type === "message"));
  const normal = parseOpenCodeOutput(output([text("one", "Inspecting"), step("one", "tool-calls"), { type: "step_start", sessionID: "ses_test", part: { id: "start_two", messageID: "msg_two" } }, text("two", "Final answer"), step("two")]));
  assert.equal(normal.status, "completed");
  assert.equal(normal.text, "Final answer");
});

test("OpenCode rejects text or tools in a new message after stop without a new step", () => {
  for (const tail of [text("two", "Unfinished response"), { type: "tool_use", sessionID: "ses_test", part: { id: "call", messageID: "msg_two", tool: "read" } }]) {
    const result = parseOpenCodeOutput(output([text("one", "Final answer"), step("one"), tail]));
    assert.equal(result.status, "failed");
    assert.equal(result.text, "Final answer");
    assert.match(result.error ?? "", /without starting a new step/u);
  }
});

test("OpenCode reconciliation appends suffixes within their original text block without extra newlines", () => {
  const partial = text("prefix", "Hel", "msg_final");
  const nextBlock = text("next", " world", "msg_final");
  const suffix = { type: "text", sessionID: "ses_test", part: { id: "prt_final_text-0", messageID: "msg_final", text: "lo" } };
  const result = parseOpenCodeOutput(output([partial, nextBlock, step("final"), suffix, suffix]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello world");
});

test("OpenCode allows late reconciliation of a completed earlier step without promoting it to final output", () => {
  const recovered = { type: "text", sessionID: "ses_test", part: { id: "prt_one_text-0", messageID: "msg_one", text: "Recovered intermediate commentary" } };
  const recoveredTool = { type: "tool_use", sessionID: "ses_test", part: { id: "call", messageID: "msg_one", tool: "read" } };
  const result = parseOpenCodeOutput(output([step("one", "tool-calls"), text("two", "Final"), step("two"), recovered, recoveredTool]));
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Final");
});

test("OpenCode nested upstream error messages survive normalization", () => {
  assert.equal(parseOpenCodeOutput(output([{ type: "error", error: { name: "APIError", data: { message: "Invalid API key" } } }])).error, "Invalid API key");
});

test("OpenCode requires the final stop step and rejects error, truncated JSON, wrong session and exit failures", () => {
  for (const events of [[], [text("one", "partial")], [step("one", "tool-calls")], [step("one", "length")], [step("one"), { type: "step_start", part: {} }], [step("one"), text("two", "unfinished next response")], [{ ...step("one"), sessionID: undefined }], [step("one"), { type: "error", error: { message: "backend rejected" } }], [step("one"), { type: "text", sessionID: "other", part: {} }]]) {
    assert.equal(parseOpenCodeOutput(output(events)).status, "failed");
  }
  assert.match(parseOpenCodeOutput(output([step("one")], { stdout: JSON.stringify(step("one")) + "\n{partial" })).error ?? "", /malformed/u);
  assert.equal(parseOpenCodeOutput(output([step("one")], { exitCode: 1 })).status, "failed");
  assert.equal(parseOpenCodeOutput(output([step("one")], { timedOut: true, exitCode: null, signal: "SIGTERM" })).status, "timeout");
  assert.equal(parseOpenCodeOutput(output([step("one")], { error: "output limit" })).error, "output limit");
});

function exportedSession() {
  return {
    info: { id: "ses_test", model: { id: "test-model", providerID: "js_llmlab" }, outcome: "succeeded", time: { idle: 20 }, location: { directory: context.workspace }, tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 7, write: 1 } }, cost: 0 },
    messages: [
      { id: "msg_user", type: "user", text: context.prompt },
      { id: "msg_one", type: "assistant", model: { id: "test-model", providerID: "js_llmlab" }, time: { completed: 19 }, finish: "stop", content: [{ type: "text", text: "Hello" }] },
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
    ],
  };
}
function inspected(value: unknown = exportedSession(), overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { ...output([]), stdout: JSON.stringify(value), ...overrides };
}
function missingTerminal(): ProcessResult {
  return output([{ type: "step_start", sessionID: "ses_test", part: { id: "start_one", messageID: "msg_one" } }, text("one", "Hel")]);
}

test("OpenCode inspection uses only the current isolated session with no model credential", () => {
  const plan = planOpenCodeInspection(target(), context, "ses_test");
  assert.deepEqual(plan.args, ["session", "export", "--standalone", "ses_test"]);
  assert.equal(plan.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
  assert.equal(plan.env?.HOME, context.home);
  assert.equal(plan.cwd, context.workspace);
  assert.equal(plan.terminationGraceMs, 4000);
  assert.throws(() => planOpenCodeInspection(target(), context, "--other"), /Invalid OpenCode session/u);
});

test("OpenCode durable native export recovers the missing step_finish race with complete output and run usage", () => {
  const run = missingTerminal();
  assert.equal(parseOpenCodeOutput(run).status, "failed");
  const result = parseOpenCodeInspection(target(), context, run, inspected());
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Hello");
  assert.equal(result.sessionId, "ses_test");
  assert.equal(result.error, null);
  assert.equal(result.cost, null);
  assert.deepEqual(result.usage, { promptTokens: 18, completionTokens: 5, totalTokens: 23, reasoningTokens: 2, promptCacheHitTokens: 7, promptCacheMissTokens: 11 });
  assert.ok(result.events.some((event) => event.type === "raw" && JSON.stringify(event.data).includes("opencode-session-export")));
});

test("OpenCode inspection cannot turn stream failures into success", () => {
  for (const run of [output([step("one", "length")]), output([{ type: "error", error: { message: "backend rejected" } }]), output([step("one"), text("two", "unexpected")]), output([step("one"), { type: "text", sessionID: "other", part: {} }]), output([step("one")], { stdout: JSON.stringify(step("one")) + "\ninvalid" }), output([step("one")], { exitCode: 1 }), output([step("one")], { timedOut: true, exitCode: null })]) {
    assert.notEqual(parseOpenCodeInspection(target(), context, run, inspected()).status, "completed");
  }
});

test("OpenCode inspection recovery uses structural state rather than a native error's text", () => {
  const run = output([{ type: "step_start", sessionID: "ses_test", part: { id: "start_one", messageID: "msg_one" } }, text("one", "Hel"), { type: "error", sessionID: "ses_test", error: { message: "OpenCode ended without a terminal stop step" } }]);
  const result = parseOpenCodeInspection(target(), context, run, inspected());
  assert.equal(result.status, "failed");
  assert.equal(result.error, "OpenCode ended without a terminal stop step");
  assert.ok(result.events.some((event) => event.type === "error"));
});

test("OpenCode inspection requires matching session, route, workspace, input and a successful completed native stop", () => {
  const valid = exportedSession();
  const cases = [
    { ...valid, info: { ...valid.info, id: "ses_other" } },
    { ...valid, info: { ...valid.info, model: { ...valid.info.model, id: "other-model" } } },
    { ...valid, info: { ...valid.info, model: { ...valid.info.model, providerID: "unexpected" } } },
    { ...valid, info: { ...valid.info, location: { directory: "/other" } } },
    { ...valid, info: { ...valid.info, outcome: "running" } },
    { ...valid, messages: valid.messages.slice(0, -1) },
    { ...valid, messages: valid.messages.map((message) => message.type === "idle" ? { ...message, outcome: "failed" } : message) },
    { ...valid, messages: valid.messages.map((message) => message.type === "user" ? { ...message, text: "different prompt" } : message) },
    { ...valid, messages: valid.messages.map((message) => message.type === "assistant" ? { ...message, id: "msg_other" } : message) },
    { ...valid, messages: valid.messages.map((message) => message.type === "assistant" ? { ...message, finish: "tool-calls" } : message) },
    { ...valid, messages: valid.messages.map((message) => message.type === "assistant" ? { ...message, time: {} } : message) },
    { ...valid, messages: valid.messages.map((message) => message.type === "assistant" ? { ...message, content: [{ type: "text", text: "Wrong response" }] } : message) },
  ];
  for (const value of cases) assert.equal(parseOpenCodeInspection(target(), context, missingTerminal(), inspected(value)).status, "failed");
});

test("OpenCode inspection failures and timeouts remain failures with unknown aggregate usage", () => {
  assert.equal(parseOpenCodeInspection(target(), context, missingTerminal(), inspected(undefined, { stdout: "not JSON" })).status, "failed");
  assert.equal(parseOpenCodeInspection(target(), context, missingTerminal(), inspected(undefined, { exitCode: 1 })).status, "failed");
  assert.equal(parseOpenCodeInspection(target(), context, missingTerminal(), inspected(undefined, { error: "spawn unavailable" })).status, "failed");
  const timeout = parseOpenCodeInspection(target(), context, missingTerminal(), inspected(undefined, { timedOut: true, exitCode: null, signal: "SIGTERM" }));
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.usage, null);
});
