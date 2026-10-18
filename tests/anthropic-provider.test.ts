import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { runOnce } from "../src/commands/run.ts";
import { runCompare } from "../src/commands/compare.ts";
import { runOfficial } from "../src/commands/official.ts";
import { buildChatRequest, runCompletion } from "../src/lib/client.ts";
import { collectConfigRefs, listProviders, loadProvider, peekConfigRef } from "../src/lib/config.ts";
import { isRecord } from "../src/lib/parse.ts";
import { LabStore } from "../src/lib/store.ts";
import type { ResolvedConfig } from "../src/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

const silent = (): void => {};
const repo = path.resolve(import.meta.dirname, "..");
const config: ResolvedConfig = {
  name: "claude-sonnet", provider: "anthropic", baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5",
  temperature: 1, maxTokens: 128, thinking: null, reasoningEffort: null, timeoutMs: 1000, maxRetries: 0,
  apiKeyEnv: "TEST_ANTHROPIC_KEY", apiKey: "sk-ant-offline-fake",
};
const messages = [{ role: "user", content: "hello" }] satisfies Parameters<typeof buildChatRequest>[1];

function lab(): ReturnType<typeof makeCommandLab> {
  const result = makeCommandLab();
  writeJson(path.join(result.root, "providers", "anthropic.json"), { name: "anthropic", baseURL: config.baseURL, model: config.model, apiKeyEnv: config.apiKeyEnv, temperature: 1, maxRetries: 0 });
  for (const family of ["sonnet", "opus", "haiku"]) writeJson(path.join(result.root, "configs", `claude-${family}.json`), { name: `claude-${family}`, provider: "anthropic", model: `claude-${family}-5-5` });
  return { root: result.root, env: { ...result.env, TEST_ANTHROPIC_KEY: config.apiKey } };
}

test("仓库预置四个provider与Claude三路，默认仍llmcore，dry-run不需要key", () => {
  assert.deepEqual(listProviders(repo), ["anthropic", "deepseek", "llmcore", "openai"]);
  assert.equal(loadProvider(repo, "anthropic").apiKeyEnv, "ANTHROPIC_API_KEY");
  for (const family of ["sonnet", "opus", "haiku"]) {
    const peek = peekConfigRef(repo, `claude-${family}`);
    assert.equal(peek.snapshot.model, `claude-${family}-5-5`);
    assert.equal(peek.snapshot.provider, "anthropic");
    assert.equal(peek.snapshot.temperature, 1);
    assert.equal(peek.snapshot.thinking, null);
    assert.equal(peek.snapshot.reasoningEffort, null);
  }
  assert.deepEqual(collectConfigRefs({ suite: "claude" }, repo), ["claude-sonnet", "claude-opus", "claude-haiku"]);
  assert.equal(loadProvider(repo, "llmcore").model, "deepseek-chat");
});

test("Anthropic兼容请求不假装支持reasoning/JSON/schema/Files等字段，DeepSeek保持原行为", () => {
  const request = buildChatRequest(config, messages, true);
  assert.equal(request.temperature, 1);
  assert.equal(request.reasoning_effort, undefined);
  assert.equal(request.thinking, undefined);
  assert.throws(() => buildChatRequest({ ...config, thinking: "enabled" }, messages, false), /api messages/u);
  assert.throws(() => buildChatRequest({ ...config, reasoningEffort: "high" }, messages, false), /api messages/u);
  assert.throws(() => buildChatRequest({ ...config, temperature: 0.3 }, messages, false), /temperature=1/u);
  for (const extras of [
    { response_format: { type: "json_object" } }, { logprobs: true },
    { tools: [{ type: "function", function: { name: "f", strict: true } }] },
    { functions: [{ name: "f", strict: true }] },
    { messages: [{ role: "user", content: [{ type: "file", file_id: "file_id" }] }] },
    { messages: [{ role: "assistant", content: "prefix", prefix: true }] },
    { messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] },
    { tool_choice: "required" },
    { top_p: 0.95 }, { n: 2 }, { stop: [" "] },
  ]) assert.throws(() => buildChatRequest(config, messages, false, extras));
  const deepseek = { ...config, provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-flash", temperature: 0.3, thinking: "enabled" } satisfies ResolvedConfig;
  assert.deepEqual(buildChatRequest(deepseek, messages, false).thinking, { type: "enabled" });
});

test("Claude run与compare沿用假completer注入，缺key时dry-run不落盘", async () => {
  const { root, env } = lab();
  const fake = createFakeCompleter();
  await withEnvAsync({ ...env, TEST_ANTHROPIC_KEY: undefined }, async () => {
    const out: string[] = [];
    await runOnce({ config: "claude-sonnet", message: "q", dryRun: true }, { root, complete: fake.complete, log: (line) => out.push(line), error: silent });
    assert.match(out.join(""), /claude-sonnet-5-5/u);
    assert.equal(fake.calls.length, 0);
  });
  await withEnvAsync(env, async () => {
    await runOnce({ config: "claude-sonnet", message: "q" }, { root, complete: fake.complete, log: silent, error: silent });
    await runCompare({ configs: "a,claude-sonnet", message: "q" }, { root, complete: fake.complete, log: silent, error: silent });
  });
  assert.ok(fake.calls.some((call) => call.config.provider === "test"));
  assert.ok(fake.calls.some((call) => call.config.provider === "anthropic"));
  const store = new LabStore(root);
  for (const session of store.listSessions()) for (const node of store.listNodes(session.id)) assert.equal(node.messages.reasoning, null);
});

test("真实OpenAI SDK接本地假Anthropic兼容服务：普通/流式、headers、usage与raw", async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${config.apiKey}`);
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request: unknown = JSON.parse(body);
    assert.ok(isRecord(request));
    assert.equal(request.temperature, 1);
    assert.equal(request.reasoning_effort, undefined);
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, completion_tokens_details: {}, prompt_tokens_details: {} };
    res.setHeader("request-id", "req-ant-test");
    if (request.stream === true) {
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ id: "msg_test", model: config.model, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: "msg_test", model: config.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_test", model: config.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const local = { ...config, baseURL: `http://127.0.0.1:${String(address.port)}/v1` };
    for (const stream of [false, true]) {
      const out: string[] = [];
      const result = await runCompletion(local, messages, { stream, onDelta: (text) => out.push(text) });
      assert.equal(result.text, "OK");
      assert.equal(result.reasoning, null);
      assert.equal(result.usage?.reasoningTokens, null);
      assert.equal(result.usage?.totalTokens, 7);
      assert.equal(result.requestId, "req-ant-test");
      assert.equal(result.responseModel, config.model);
      assert.equal(JSON.stringify(result.raw).includes(config.apiKey), false);
      if (stream) assert.equal(out.join(""), "OK");
    }
  } finally { server.close(); await once(server, "close"); }
});

test("api messages的Anthropic原生路由/鉴权正确，原始thinking与output_config不改写", async () => {
  const { root, env } = lab();
  await withEnvAsync(env, async () => {
    const out: string[] = [];
    const native = { model: config.model, messages: [{ role: "user", content: "hello" }], thinking: { type: "adaptive" }, output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } } };
    await runOfficial("messages", { provider: "anthropic", request: JSON.stringify(native) }, {}, {
      root, stdout: (text) => out.push(text), stderr: silent,
      fetch: async (url, init) => {
        assert.equal(url, "https://api.anthropic.com/v1/messages");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("x-api-key"), config.apiKey);
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        assert.equal(headers.has("authorization"), false);
        const body: unknown = JSON.parse(String(init.body));
        assert.ok(isRecord(body));
        assert.deepEqual(body.thinking, native.thinking);
        assert.deepEqual(body.output_config, native.output_config);
        return new Response(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 2 } }), { headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(out.join(""), "OK\n");
  });
});
