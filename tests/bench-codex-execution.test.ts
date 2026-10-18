import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runBench } from "../src/commands/bench.ts";
import { runCodexMetadata, runCodexTargetInit } from "../src/commands/codex.ts";
import { executeTarget } from "../src/lib/bench/executor.ts";
import { planHarness } from "../src/lib/bench/harness.ts";
import type { ExecutionInput, ProcessRequest, ProcessResult, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";
import { makeLabRoot, withEnvAsync, writeJson } from "./helpers.ts";

function target(codexHome = "/existing-codex-auth"): ResolvedHarnessTarget {
  const backend = { auth: "chatgpt", model: "catalog-model", reasoningEffort: "xhigh", codexHome, credentialsStore: "auto" } as const;
  return { name: "subscription", kind: "harness", definition: { name: "subscription", kind: "harness", harness: "codex-write", backend },
    profile: { name: "codex-write", adapter: "codex", executable: "/fake/codex", permission: "workspace-write" }, backend };
}
function output(stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1, ...overrides };
}
const success = [
  { type: "thread.started", thread_id: "isolated-thread" },
  { type: "item.completed", item: { type: "agent_message", text: "done" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 4 } },
].map((event) => JSON.stringify(event)).join("\n");

async function input(): Promise<ExecutionInput> {
  const root = await mkdtemp(path.join(tmpdir(), "llmlab-subscription-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  return { root, target: target(path.join(root, "current-auth")), workspace, home: path.join(root, "home"),
    task: { name: "task", prompt: "Do the task", timeoutMs: 1000, checks: [] } };
}

test("subscription plan reuses native auth and selects exact model/effort without API routes or credentials", () => {
  const plan = planHarness(target(), { home: "/isolated/home", workspace: "/isolated/workspace", prompt: "question", timeoutMs: 1000 }, "must-not-be-used");
  assert.equal(plan.process.env?.HOME, "/isolated/home");
  assert.equal(plan.process.env?.CODEX_HOME, "/existing-codex-auth");
  assert.equal(plan.process.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
  assert.equal(plan.process.env?.OPENAI_API_KEY, undefined);
  assert.equal(plan.process.args[plan.process.args.indexOf("--model") + 1], "catalog-model");
  for (const value of ['model_provider="openai"', 'model_reasoning_effort="xhigh"', 'cli_auth_credentials_store="auto"',
    "--ignore-user-config", "--ignore-rules", "--ephemeral", "--no-daemon", "features.skip_host_skill_discovery=true", "features.plugins=false", "features.hooks=false"]) {
    assert.ok(plan.process.args.includes(value), value);
  }
  assert.equal(plan.process.args.some((value) => value.includes("forced_login_method") || value.includes("model_providers.js_llmlab")), false);
  assert.equal(plan.process.args.includes("--sandbox"), false);
  assert.ok(plan.process.args.includes('default_permissions="js_llmlab_subscription"'));
  assert.ok(plan.process.args.includes('permissions.js_llmlab_subscription.extends=":workspace"'));
  assert.ok(plan.process.args.includes('permissions.js_llmlab_subscription.filesystem={ "/existing-codex-auth" = "deny" }'));
  const readonly = target();
  readonly.profile.permission = "read-only";
  assert.ok(planHarness(readonly, { home: "/isolated/home", workspace: "/isolated/workspace", prompt: "question", timeoutMs: 1000 }).process.args.includes('permissions.js_llmlab_subscription.extends=":read-only"'));
  assert.equal(JSON.stringify(plan).includes("must-not-be-used"), false);
  assert.deepEqual(plan.files, []);
});

test("subscription executes after safe account check without a key or copying authentication", async () => {
  const context = await input();
  const requests: ProcessRequest[] = [];
  const parentHome = process.env.HOME;
  const parentCodexHome = process.env.CODEX_HOME;
  try {
    await withEnvAsync({ OPENAI_API_KEY: "unrelated-api-key", HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.test:8888" }, async () => {
      const result = await executeTarget(context, { runProcess: async (request) => {
        requests.push(request);
        if (requests.length === 1) return output("codex-cli test-version");
        if (requests.length === 2) return output("Logged in using ChatGPT");
        return output(success);
      } });
      assert.equal(result.status, "completed");
      assert.equal(result.usage?.totalTokens, 13);
      assert.equal(result.cost, null);
      assert.equal(result.costSource, null);
      assert.equal(requests.length, 3);
      assert.equal(requests[0]?.env?.CODEX_HOME, path.join(context.home, "codex-probe"));
      assert.equal(requests[2]?.env?.CODEX_HOME, path.join(context.root, "current-auth"));
      assert.equal(requests[2]?.env?.HOME, context.home);
      assert.equal(requests[2]?.env?.OPENAI_API_KEY, undefined);
      assert.equal(requests[2]?.env?.HTTPS_PROXY, "http://proxy-user:proxy-password@proxy.test:8888");
      assert.equal(JSON.stringify(result).includes("proxy-password"), false);
      assert.equal(requests[2]?.stdin, "Do the task");
      assert.ok((requests[2]?.timeoutMs ?? 0) <= context.task.timeoutMs);
      assert.equal(existsSync(path.join(context.root, "current-auth")), false);
      assert.equal(readdirSync(context.home).includes("auth.json"), false);
      assert.equal(JSON.stringify(result).includes("unrelated-api-key"), false);
      assert.equal(process.env.HOME, parentHome);
      assert.equal(process.env.CODEX_HOME, parentCodexHome);
    });
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

for (const auth of ["none", "api-key", "other"] as const) {
  test(`subscription refuses ${auth} auth without inference or changing login`, async () => {
    const context = await input();
    let calls = 0;
    try {
      const result = await executeTarget(context, { runProcess: async () => {
        calls++;
        return calls === 1 ? output("codex-cli test-version") : output(auth === "none" ? "Not logged in" : auth === "api-key" ? "Logged in using an API key - private-key" : "Unknown login format", { exitCode: auth === "none" ? 1 : 0 });
      } });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /登录/u);
      assert.equal(calls, 2);
    } finally { await rm(context.root, { recursive: true, force: true }); }
  });
}

test("subscription CLI target creation and dry-run stay offline and freeze auth/model without API provider", async () => {
  const root = makeLabRoot();
  try {
    writeJson(path.join(root, "harnesses/codex-write.json"), { name: "codex-write", adapter: "codex", executable: "/fake/codex", permission: "workspace-write" });
    writeJson(path.join(root, "tasks/answer.json"), { name: "answer", prompt: "Reply done", checks: [] });
    runCodexTargetInit("subscription", { model: "catalog-model", reasoningEffort: "high", codexHome: "unread-auth" }, { root, log: () => {} });
    const saved = JSON.parse(readFileSync(path.join(root, "targets/subscription.json"), "utf8"));
    assert.equal(saved.backend.auth, "chatgpt");
    assert.equal(saved.backend.provider, undefined);
    let calls = 0;
    let logged = "";
    await runBench({ task: "answer", targets: "subscription", dryRun: true }, { root,
      log: (text) => { logged = text; }, runProcess: async () => { calls++; throw new Error("must stay offline"); } });
    assert.equal(calls, 0);
    assert.equal(existsSync(path.join(root, "data/benchmarks")), false);
    assert.equal(existsSync(path.join(root, "unread-auth")), false);
    const snapshot = JSON.parse(logged).targets[0].target;
    assert.equal(snapshot.backend.model, "catalog-model");
    assert.equal(snapshot.backend.reasoningEffort, "high");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subscription auth timeout prevents inference and remains a task timeout", async () => {
  const context = await input();
  let calls = 0;
  try {
    const result = await executeTarget(context, { runProcess: async () => {
      calls++;
      return calls === 1 ? output("codex-cli test-version") : output("", { timedOut: true, exitCode: null });
    } });
    assert.equal(result.status, "timeout");
    assert.equal(calls, 2);
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("subscription native auth diagnostics are scrubbed without reading credentials", async () => {
  const context = await input();
  let calls = 0;
  try {
    const result = await executeTarget(context, { runProcess: async () => {
      calls++;
      if (calls === 1) return output("codex-cli test-version");
      if (calls === 2) return output("Logged in using ChatGPT");
      return output(`${JSON.stringify({ type: "future_event", access_token: "native-secret", refreshToken: "refresh-secret" })}\n${success}`, { stderr: 'Authorization: Bearer opaque-credential\n{"id_token":"native-id-secret"}' });
    } });
    assert.equal(result.status, "completed");
    for (const secret of ["native-secret", "refresh-secret", "opaque-credential", "native-id-secret"]) assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { await rm(context.root, { recursive: true, force: true }); }
});

test("metadata CLI prints safe status and dynamic model/effort choices through injected processes", async () => {
  const root = makeLabRoot();
  try {
    writeJson(path.join(root, "harnesses/codex.json"), { name: "codex", adapter: "codex", executable: "/fake/codex", permission: "read-only" });
    const logs: string[] = [];
    const deps = { root, log: (value: string) => { logs.push(value); }, runProcess: async (request: ProcessRequest) => request.args.includes("status") ? output("Logged in using ChatGPT") : output(JSON.stringify({
      account: { auth: "chatgpt", planType: null, email: "private@example.test", accessToken: "secret" },
      models: [{ id: "new-model", model: "new-model", displayName: "New", description: "model", hidden: false, isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "ultra"], inputModalities: ["text"] }],
    })) };
    await runCodexMetadata("status", {}, deps);
    await runCodexMetadata("models", {}, deps);
    assert.match(logs[0] ?? "", /ChatGPT 订阅/u);
    assert.match(logs[1] ?? "", /new-model\t是\tmedium, ultra/u);
    assert.equal(logs.join("\n").includes("private@example.test"), false);
    assert.equal(logs.join("\n").includes("secret"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
