import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { prepareChatRequest } from "../src/lib/chat-options.ts";
import { buildChatRequest, chatRequestBaseURL, requestIdFromError, runCompletion, withRetries } from "../src/lib/client.ts";
import { computeCost } from "../src/lib/cost.ts";
import type { ChatMessage, ResolvedConfig } from "../src/types.ts";
import { makeLabRoot, writeJson, writeText } from "./helpers.ts";

const config: ResolvedConfig = {
  name: "official", provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash",
  apiKey: "test-local-key", apiKeyEnv: "TEST_KEY", temperature: 1, maxTokens: 1024, thinking: "enabled",
  reasoningEffort: "high", timeoutMs: 1000, maxRetries: 0,
};
const messages: ChatMessage[] = [{ role: "system", content: "助手" }, { role: "user", content: "识图" }];
const tool = { type: "function", function: { name: "weather", parameters: { type: "object", properties: {} } } };

test("高级输入：本地图片 / URL / data URL / Files API 引用拼到最后 user，输入保持原样", async () => {
  const root = makeLabRoot();
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const file = path.join(root, "image.bin");
  writeFileSync(file, png);
  const url = `data:image/png;base64,${png.toString("base64")}`;
  const extras = await prepareChatRequest(messages, {
    image: [file, "https://example.test/image.png", url], fileId: ["file-api-image"],
  });
  assert.deepEqual(extras.messages, [messages[0], {
    role: "user", content: [
      { type: "text", text: "识图" },
      { type: "image_url", image_url: { url } },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } },
      { type: "image_url", image_url: { url } },
      { type: "file", file_id: "file-api-image" },
    ],
  }]);
  assert.equal(messages[1]?.content, "识图");
  assert.deepEqual(await prepareChatRequest(messages, {}), {});
  writeText(file, "not an image");
  await assert.rejects(prepareChatRequest(messages, { image: [file] }), /不支持的图片内容/u);
  await assert.rejects(prepareChatRequest(messages, { image: ["data:text/plain;base64,eA=="] }), /图片 data URL/u);
  await assert.rejects(prepareChatRequest(messages, { fileId: [""] }), /不能为空/u);
  await assert.rejects(prepareChatRequest(messages, { fileId: Array.from({ length: 601 }, () => "file-api-img") }), /600/u);
});

test("JSON 模式、前缀续写、工具与附加参数组合；不能覆盖配置与流模式", async () => {
  const root = makeLabRoot();
  const tools = path.join(root, "tools.json");
  const request = path.join(root, "request.json");
  writeJson(tools, [tool]);
  writeJson(request, { top_p: 0.98, tool_choice: "auto", logprobs: true, top_logprobs: 3, user_id: "lab" });
  const extras = await prepareChatRequest(messages, { tools, request, jsonOutput: true, prefix: "{" });
  const body = buildChatRequest(config, messages, true, extras);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.tools, [tool]);
  assert.equal(body.top_p, 0.98);
  assert.equal(body.model, config.model);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.match(JSON.stringify(body.messages), /请仅输出有效的 JSON 对象/u);
  assert.deepEqual(extras.messages instanceof Array ? extras.messages.at(-1) : null, { role: "assistant", content: "{", prefix: true });
  assert.equal(chatRequestBaseURL(config, body), "https://api.deepseek.com/beta");
  assert.equal(chatRequestBaseURL({ ...config, baseURL: "https://example.test/v1" }, body), "https://example.test/v1");
  for (const key of ["model", "temperature", "max_tokens", "thinking", "reasoning_effort", "stream", "stream_options", "messages"]) {
    writeJson(request, { [key]: "override" });
    await assert.rejects(prepareChatRequest(messages, { request }), /不允许覆盖/u);
    if (key !== "messages") assert.throws(() => buildChatRequest(config, messages, false, { [key]: "override" }), /不允许覆盖/u);
  }
  writeText(request, "{");
  await assert.rejects(prepareChatRequest(messages, { request }), /有效 JSON/u);
});

test("完整工具消息文件替换历史，保留空 content、tool_calls 与 reasoning_content；恢复基底不原地修改", async () => {
  const root = makeLabRoot();
  const file = path.join(root, "messages.json");
  const api = [
    { role: "user", content: "天气" },
    { role: "assistant", content: null, reasoning_content: "查天气", tool_calls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{}" } }] },
    { role: "tool", content: "晴天", tool_call_id: "call-1" },
  ];
  writeJson(file, api);
  const extras = await prepareChatRequest(messages, { messages: file });
  assert.deepEqual(extras.messages, api);
  assert.doesNotThrow(() => buildChatRequest(config, messages, false, { ...extras, tools: [tool] }));
  assert.deepEqual((await prepareChatRequest(messages, {}, api)).messages, api);
  await prepareChatRequest(messages, { jsonOutput: true }, api);
  assert.equal(api.length, 3);
  writeJson(file, [{ role: "tool", content: "x" }]);
  await assert.rejects(prepareChatRequest(messages, { messages: file }), /tool_call_id/u);
  writeJson(file, [{ role: "assistant", content: null }]);
  await assert.rejects(prepareChatRequest(messages, { messages: file }), /tool_calls/u);
});

test("官方 tools 思考历史保留 reasoning；strict 仅在已指定时启用 beta", () => {
  const missing = { messages: [{ role: "assistant", content: "上一轮" }], tools: [tool] };
  assert.throws(() => buildChatRequest(config, messages, false, missing), /reasoning_content/u);
  assert.doesNotThrow(() => buildChatRequest({ ...config, thinking: "disabled" }, messages, false, missing));
  assert.doesNotThrow(() => buildChatRequest({ ...config, baseURL: "https://proxy.example.test/v1" }, messages, false, missing));
  assert.throws(() => buildChatRequest(config, messages, false, { tools: [tool], tool_choice: "required" }), /tool_choice/u);
  const normal = buildChatRequest(config, messages, false, { tools: [tool] });
  assert.equal(chatRequestBaseURL(config, normal), config.baseURL);
  const strict = { ...tool, function: { ...tool.function, strict: true } };
  assert.equal(chatRequestBaseURL(config, { tools: [strict] }), "https://api.deepseek.com/beta");
});

async function withLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try { await run(`http://127.0.0.1:${String(address.port)}/v1`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); }
}

test("SDK 非流式响应保留真实版本、完整工具调用与缓存 token（仅本地服务器）", async () => {
  let sent: unknown;
  await withLocalServer((request, response) => {
    let input = "";
    request.on("data", (chunk: Buffer) => { input += chunk.toString(); });
    request.on("end", () => {
      sent = JSON.parse(input);
      response.setHeader("Content-Type", "application/json");
      response.setHeader("x-request-id", "local-request");
      response.end(JSON.stringify({
        id: "completion-local", object: "chat.completion", created: 1, model: "deepseek-flash-1017",
        choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "先调用", tool_calls: [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 12, prompt_cache_miss_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } },
      }));
    });
  }, async (baseURL) => {
    const result = await runCompletion({ ...config, baseURL }, messages, { request: { tools: [tool], messages } });
    assert.equal(result.text, "");
    assert.equal(result.reasoning, "先调用");
    assert.equal(result.responseModel, "deepseek-flash-1017");
    assert.equal(result.requestId, "local-request");
    assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 5, totalTokens: 25, reasoningTokens: 3, promptCacheHitTokens: 12, promptCacheMissTokens: 8 });
    assert.deepEqual(result.assistantMessage?.tool_calls, [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{}" } }]);
    assert.deepEqual(result.raw?.request, sent);
  });
});

test("SDK 流式工具参数按 index 拼接，raw 与 assistantMessage 可原样续接（仅本地服务器）", async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "查询", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "weather", arguments: "{\"city\":" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"上海\"}" } }, { index: 1, id: "call-2", type: "function", function: { name: "clock", arguments: "{}" } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } } },
  ];
  await withLocalServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "text/event-stream");
      for (const chunk of chunks) response.write(`data: ${JSON.stringify({ id: "stream-local", object: "chat.completion.chunk", created: 1, model: "deepseek-flash-1017", ...chunk })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  }, async (baseURL) => {
    const result = await runCompletion({ ...config, baseURL }, messages, { stream: true, request: { tools: [tool] } });
    assert.equal(result.raw?.chunkCount, 3);
    assert.equal(result.responseModel, "deepseek-flash-1017");
    assert.equal(result.assistantMessage?.content, null);
    assert.equal(result.assistantMessage?.reasoning_content, "查询");
    assert.deepEqual(result.assistantMessage?.tool_calls, [
      { id: "call-1", type: "function", function: { name: "weather", arguments: "{\"city\":\"上海\"}" } },
      { id: "call-2", type: "function", function: { name: "clock", arguments: "{}" } },
    ]);
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, reasoningTokens: null, promptCacheHitTokens: 6, promptCacheMissTokens: 4 });
    assert.ok(result.raw?.response !== null);
  });
});

test("SDK 缓存统计异常时省略两项并回退统一输入价，raw 保留原始值（仅本地服务器）", async () => {
  const invalid: Record<string, unknown>[] = [
    { prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 11 },
    { prompt_cache_hit_tokens: 2.5, prompt_cache_miss_tokens: 7.5 },
    { prompt_cache_hit_tokens: 11, prompt_cache_miss_tokens: 0 },
    { prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 3 },
    { prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 5 },
    { prompt_cache_hit_tokens: "6", prompt_cache_miss_tokens: 4 },
    { prompt_cache_miss_tokens: 4 },
    { prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens_details: { cached_tokens: 11 } },
  ];
  let index = 0;
  await withLocalServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        id: "local", object: "chat.completion", created: 1, model: "local",
        choices: [{ index: 0, message: { role: "assistant", content: "完整结果" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, ...invalid[index] },
      }));
    });
  }, async (baseURL) => {
    for (index = 0; index < invalid.length; index += 1) {
      const result = await runCompletion({ ...config, baseURL }, messages);
      assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 2, totalTokens: 12, reasoningTokens: null });
      assert.equal(computeCost(result.usage, { inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 20, currency: "CNY" })?.input, 0.0001);
      assert.ok(JSON.stringify(result.raw?.response).includes(JSON.stringify(invalid[index]).slice(1, -1)));
    }
  });
});

test("截断的 SSE 工具调用不能算成功；未展示内容时可重试（仅本地服务器）", async () => {
  let attempts = 0;
  await withLocalServer((request, response) => {
    request.resume();
    request.on("end", () => {
      attempts += 1;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("x-request-id", `local-${String(attempts)}`);
      const delta = { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "weather", arguments: attempts === 1 ? "{" : "{}" } }] };
      response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      if (attempts > 1) response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      response.end();
    });
  }, async (baseURL) => {
    const complete = withRetries(runCompletion, { baseDelayMs: 0 });
    const result = await complete({ ...config, baseURL, maxRetries: 1 }, messages, { stream: true, request: { tools: [tool] } });
    assert.equal(attempts, 2);
    assert.equal(result.requestId, "local-2");
    assert.deepEqual(result.assistantMessage?.tool_calls, [{ id: "call-1", type: "function", function: { name: "weather", arguments: "{}" } }]);
  });
});

test("SSE 已输出正文后出错不重试，保留错误 request id（仅本地服务器）", async () => {
  let attempts = 0;
  const deltas: string[] = [];
  await withLocalServer((request, response) => {
    request.resume();
    request.on("end", () => {
      attempts += 1;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("x-request-id", "local-sse-error");
      response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: { content: "开头" }, finish_reason: null }] })}\n\n`);
      response.end(`event: error\ndata: ${JSON.stringify({ error: { message: "upstream interrupted", type: "server_error" } })}\n\n`);
    });
  }, async (baseURL) => {
    const complete = withRetries(runCompletion, { baseDelayMs: 0 });
    await assert.rejects(complete({ ...config, baseURL, maxRetries: 2 }, messages, { stream: true, onDelta: (text) => deltas.push(text) }), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /upstream interrupted/u);
      assert.equal(requestIdFromError(error), "local-sse-error");
      return true;
    });
    assert.equal(attempts, 1);
    assert.deepEqual(deltas, ["开头"]);
  });
});

test("服务端声明 aborted 不能被记录成成功（仅本地服务器）", async () => {
  await withLocalServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("x-request-id", "local-aborted");
      response.end(JSON.stringify({ id: "local", object: "chat.completion", created: 1, model: "local", choices: [{ index: 0, message: { role: "assistant", content: "没写完" }, finish_reason: "aborted" }] }));
    });
  }, async (baseURL) => {
    await assert.rejects(runCompletion({ ...config, baseURL }, messages), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /模型响应被中断：aborted/u);
      assert.equal(requestIdFromError(error), "local-aborted");
      return true;
    });
  });
});
