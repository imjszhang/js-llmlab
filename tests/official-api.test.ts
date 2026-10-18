import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { registerOfficialCommands, runOfficial } from "../src/commands/official.ts";
import { resolveConfig } from "../src/lib/config.ts";
import {
  executeOfficialRequest,
  prepareOfficialRequest,
  readOfficialHeaders,
  readOfficialRequest,
} from "../src/lib/official-api.ts";
import type { OfficialFetch, OfficialOperation } from "../src/lib/official-api.ts";
import type { ResolvedConfig } from "../src/types.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

function lab(): { root: string; env: Record<string, string | undefined>; config: ResolvedConfig } {
  const result = makeCommandLab();
  writeJson(path.join(result.root, "providers", "deepseek.json"), {
    name: "deepseek", baseURL: "https://api.deepseek.com", apiKeyEnv: "TEST_OFFICIAL_KEY", model: "deepseek-flash", maxRetries: 0,
  });
  return {
    ...result,
    env: { ...result.env, TEST_OFFICIAL_KEY: "sk-official-secret" },
    config: { name: "official", provider: "deepseek", baseURL: "https://api.deepseek.com", model: "deepseek-flash", temperature: 0.3, maxTokens: 4096, thinking: null, reasoningEffort: null, timeoutMs: 1000, maxRetries: 0, apiKey: "sk-official-secret", apiKeyEnv: "TEST_OFFICIAL_KEY" },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": "req-official" } });
}

function streamResponse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } });
}

function readJson(file: string): unknown { return JSON.parse(readFileSync(file, "utf8")); }

// All network behavior in this file is injected; no official API key is used.
test("official endpoint selection, protocol defaults and opaque fields", () => {
  const { config } = lab();
  const advanced = { messages: [{ role: "user", content: [{ type: "file", file_id: "file-api-image" }] }, { role: "assistant", content: "prefix", prefix: true }], tools: [{ type: "function", function: { name: "f", strict: true, parameters: { type: "object" } } }], response_format: { type: "json_object" }, unknown_future_field: { keep: true }, max_tokens: 100, model: "deepseek-v4-pro" };
  const request = prepareOfficialRequest({ ...config, baseURL: "https://api.deepseek.com/v1" }, { operation: "chat", body: advanced, beta: true });
  assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
  assert.deepEqual(request.body, advanced);
  const endpoints: Array<[OfficialOperation, string]> = [["responses", "/responses"], ["messages", "/anthropic/v1/messages"], ["fim", "/beta/completions"], ["search", "/v1/tools/search"], ["fetch", "/v1/tools/fetch"], ["models", "/models"], ["balance", "/user/balance"]];
  for (const [operation, endpoint] of endpoints) assert.equal(prepareOfficialRequest(config, { operation }).url, `https://api.deepseek.com${endpoint}`);
  const responseRequest = prepareOfficialRequest({ ...config, reasoningEffort: "high" }, { operation: "responses", body: { input: "x", tools: [{ type: "web_search" }] } });
  assert.deepEqual(responseRequest.body?.reasoning, { effort: "high" });
  assert.equal(responseRequest.body?.max_output_tokens, 4096);
  assert.equal(prepareOfficialRequest(config, { operation: "fim" }).body?.max_tokens, 4096);
});

test("raw JSON files and safe additional headers", () => {
  const { root } = lab();
  const file = path.join(root, "request.json");
  writeJson(file, { input: [{ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" }] });
  assert.deepEqual(readOfficialRequest(file), { input: [{ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" }] });
  assert.deepEqual(readOfficialHeaders('{"Anthropic-Beta":"files-api-2025-04-14"}'), { "anthropic-beta": "files-api-2025-04-14" });
  assert.throws(() => readOfficialHeaders('{"Authorization":"Bearer secret"}'), /不允许覆盖/u);
  assert.throws(() => readOfficialRequest("[]"));
});

test("raw transport preserves full JSON and redacts request, response, terminal and logs", async () => {
  const { root, config } = lab();
  const prepared = prepareOfficialRequest(config, { operation: "responses", body: { input: config.apiKey, tools: [{ type: "function", name: "run_shell" }] } });
  let seen = false;
  const result = await executeOfficialRequest(root, config, prepared, {
    fetch: async (url, init) => {
      seen = true;
      assert.equal(url, "https://api.deepseek.com/responses");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${config.apiKey}`);
      assert.equal(init.redirect, "error");
      assert.equal(typeof init.body, "string");
      return jsonResponse({ output: [{ type: "message", content: [{ type: "output_text", text: `answer ${config.apiKey}` }] }, { type: "function_call", name: "run_shell", arguments: "{}" }], usage: { input_tokens: 10, output_tokens: 5 }, vendor_extension: [1, 2] });
    },
  });
  assert.ok(seen);
  assert.equal(result.text, "answer ***");
  assert.equal(result.requestId, "req-official");
  for (const file of readdirSync(result.dir)) assert.ok(!readFileSync(path.join(result.dir, file), "utf8").includes(config.apiKey), file);
  assert.match(JSON.stringify(readJson(path.join(result.dir, "response.json"))), /vendor_extension/u);
  assert.match(JSON.stringify(result.response), /run_shell/u);
});

test("SSE Responses retains every event, CRLF boundaries, tools and terminal usage", async () => {
  const { root, config } = lab();
  const printed: string[] = [];
  const final = { output: [{ type: "message", content: [{ type: "output_text", text: "你好" }] }, { type: "function_call", name: "f", arguments: "{}" }], usage: { input_tokens: 5, output_tokens: 4 } };
  const result = await executeOfficialRequest(root, config, prepareOfficialRequest(config, { operation: "responses", body: { input: "x", stream: true } }), {
    fetch: async () => streamResponse([
      ': heartbeat\r',
      '\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你"}\r\n\r',
      '\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"好"}\n\n',
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: final })}\n\n`,
    ]),
    onText: (text) => printed.push(text),
  });
  assert.equal(printed.join(""), "你好");
  assert.equal(result.text, "你好");
  assert.equal(result.events.length, 4);
  assert.deepEqual(result.response, final);
  assert.deepEqual(readJson(path.join(result.dir, "events.json")), result.events);
  assert.match(readFileSync(path.join(result.dir, "response.txt"), "utf8"), /heartbeat/u);
});

test("SSE splits credentials safely across text deltas and supports Chat / Anthropic", async () => {
  for (const operation of ["chat", "messages"] satisfies Array<"chat" | "messages">) {
    const { root, config } = lab();
    const printed: string[] = [];
    const delta = (text: string): string => JSON.stringify(operation === "chat" ? { choices: [{ delta: { content: text } }] } : { type: "content_block_delta", delta: { type: "text_delta", text } });
    const result = await executeOfficialRequest(root, config, prepareOfficialRequest(config, { operation, body: { stream: true } }), {
      fetch: async (_url, init) => {
        if (operation === "messages") assert.equal(new Headers(init.headers).get("x-api-key"), config.apiKey);
        return streamResponse([`data: ${delta("sk-official-")}\n\n`, `data: ${delta("secret")}\n\n`, operation === "chat" ? "data: [DONE]\n\n" : 'event: message_stop\ndata: {"type":"message_stop"}\n\n']);
      }, onText: (text) => printed.push(text),
    });
    assert.equal(result.text, "***");
    assert.equal(printed.join(""), "***");
  }
});

test("SSE terminal errors and premature close save partial events and redact thrown errors", async () => {
  for (const terminalError of [false, true]) {
    const { root, config } = lab();
    await assert.rejects(executeOfficialRequest(root, config, prepareOfficialRequest(config, { operation: "responses", body: { stream: true } }), {
      fetch: async () => streamResponse(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', ...(terminalError ? [`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: config.apiKey } } })}\n\n`] : [])]),
    }), (error: unknown) => error instanceof Error && !error.message.includes(config.apiKey) && /记录/u.test(error.message));
    const id = readdirSync(path.join(root, "data", "api"))[0];
    assert.ok(id);
    const dir = path.join(root, "data", "api", id);
    assert.match(readFileSync(path.join(dir, "events.json"), "utf8"), /partial/u);
    assert.ok(!readFileSync(path.join(dir, "meta.json"), "utf8").includes(config.apiKey));
  }
});

test("request timeout covers reading an SSE body and records failure", async () => {
  const { root, config } = lab();
  let cancelled = false;
  await assert.rejects(executeOfficialRequest(root, { ...config, timeoutMs: 15 }, prepareOfficialRequest(config, { operation: "responses", body: { stream: true } }), {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }),
  }), /超过 15 ms/u);
  assert.ok(cancelled);
  assert.equal(readdirSync(path.join(root, "data", "api")).length, 1);
});

test("Search retries retryable HTTP statuses, never permanent errors", async () => {
  for (const status of [400, 408, 429, 500]) {
    const { root, config } = lab();
    let calls = 0;
    const task = executeOfficialRequest(root, { ...config, maxRetries: 1 }, prepareOfficialRequest(config, { operation: "search", body: { query: "x", count: 5, need_content: true } }), {
      fetch: async () => { calls += 1; return calls === 1 ? jsonResponse({ error: { message: "fail" } }, status) : jsonResponse({ results: [] }); }, retryBaseDelayMs: 0,
    });
    if (status === 400) await assert.rejects(task, /HTTP 400/u); else await task;
    assert.equal(calls, status === 400 ? 1 : 2);
  }
});

test("Files upload uses multipart expiry fields, never retries, and supports Anthropic CRUD paths", async () => {
  const { root, config } = lab();
  const image = path.join(root, "image.png");
  writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
  const prepared = prepareOfficialRequest(config, { operation: "files.upload", file: image, body: { expires_after: { anchor: "created_at", seconds: 3600 } } });
  let calls = 0;
  await assert.rejects(executeOfficialRequest(root, { ...config, maxRetries: 3 }, prepared, { fetch: async (_url, init) => {
    calls += 1;
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("purpose"), "user_data");
    assert.equal(init.body.get("expires_after[anchor]"), "created_at");
    assert.equal(init.body.get("expires_after[seconds]"), "3600");
    const file = init.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.size, 8);
    assert.equal(new Headers(init.headers).has("content-type"), false);
    return jsonResponse({ error: "temporary" }, 500);
  } }), /HTTP 500/u);
  assert.equal(calls, 1);
  const listed = prepareOfficialRequest({ ...config, baseURL: "https://api.deepseek.com/anthropic" }, { operation: "files.list", anthropic: true, body: { after_id: "file-a", limit: 20 } });
  assert.equal(listed.url, "https://api.deepseek.com/anthropic/v1/files?after_id=file-a&limit=20");
  assert.equal(listed.headers["anthropic-beta"], "files-api-2025-04-14");
  assert.equal(prepareOfficialRequest(config, { operation: "files.get", fileId: "file-api-a" }).url, "https://api.deepseek.com/files/file-api-a");
  assert.equal(prepareOfficialRequest(config, { operation: "files.delete", fileId: "file-api-a", anthropic: true }).method, "DELETE");
});

test("CLI dry-run works without keys and preserves config provider selection", async () => {
  const { root, env } = lab();
  await withEnvAsync({ ...env, TEST_OFFICIAL_KEY: undefined, TEST_KEY: undefined }, async () => {
    const printed: string[] = [];
    const deps = { root, stdout: (text: string): void => { printed.push(text); }, stderr: (): void => {}, fetch: async (): Promise<Response> => { throw new Error("dry-run must not fetch"); } };
    const program = new Command();
    registerOfficialCommands(program, deps);
    await program.parseAsync(["node", "cli", "api", "responses", "--request", '{"input":"x"}', "--dry-run"]);
    assert.match(printed.join(""), /api\.deepseek\.com\/responses/u);
    printed.length = 0;
    await runOfficial("chat", { config: "a", request: '{"messages":[]}', dryRun: true }, {}, deps);
    assert.match(printed.join(""), /example\.test\/v1\/chat\/completions/u);
    assert.match(printed.join(""), /model-a/u);
    assert.equal(existsSync(path.join(root, "data", "api")), false);
  });
});

test("CLI stdout is composable and explicit model/stream flags override JSON", async () => {
  const { root, env } = lab();
  await withEnvAsync(env, async () => {
    const out: string[] = [];
    const err: string[] = [];
    const transport: OfficialFetch = async (_url, init) => {
      assert.equal(typeof init.body, "string");
      const body: unknown = JSON.parse(String(init.body));
      assert.ok(typeof body === "object" && body !== null && "model" in body && body.model === "deepseek-v4-pro");
      return jsonResponse({ choices: [{ message: { content: "正文" } }] });
    };
    await runOfficial("chat", { request: '{"model":"deepseek-flash","messages":[]}', model: "deepseek-v4-pro" }, {}, { root, fetch: transport, stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
    assert.equal(out.join(""), "正文\n");
    assert.match(err.join(""), /记录/u);
    const config = resolveConfig(root, undefined, { provider: "deepseek" });
    assert.equal(config.model, "deepseek-flash");
  });
});

test("Responses maps disabled thinking to none and retains explicit request reasoning", () => {
  const { config } = lab();
  const disabled = { ...config, thinking: "disabled", reasoningEffort: "high" } satisfies ResolvedConfig;
  assert.deepEqual(prepareOfficialRequest(disabled, { operation: "responses", body: { input: "x", reasoning: { summary: "auto" } } }).body?.reasoning, { summary: "auto", effort: "none" });
  assert.deepEqual(prepareOfficialRequest(disabled, { operation: "responses", body: { reasoning: { effort: "low" } } }).body?.reasoning, { effort: "low" });
  assert.deepEqual(prepareOfficialRequest({ ...config, thinking: "enabled" }, { operation: "responses" }).body?.reasoning, { effort: "high" });
});

test("retry followed by tool-only Chat SSE clears previous error and exposes all tool events", async () => {
  const { root, env } = lab();
  await withEnvAsync(env, async () => {
    let attempts = 0;
    const out: string[] = [];
    const result = await runOfficial("chat", { request: '{"messages":[],"stream":true}', maxRetries: "1" }, {}, {
      root, retryBaseDelayMs: 0,
      stdout: (text) => out.push(text), stderr: () => {},
      fetch: async () => {
        attempts += 1;
        return attempts === 1 ? jsonResponse({ error: "retry" }, 429) : streamResponse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"run_shell","arguments":"{}"}}]}}]}\n\n', 'data: [DONE]\n\n']);
      },
    });
    assert.equal(attempts, 2);
    assert.match(out.join(""), /run_shell/u);
    assert.equal(result?.response, null);
    assert.ok(result);
    assert.ok(existsSync(path.join(result.dir, "attempt-1.json")));
    assert.ok(!readFileSync(path.join(result.dir, "response.txt"), "utf8").includes("retry"));
  });
});

test("HTTP 200 non-JSON is a captured failure and JSON response timeout is enforced", async () => {
  const { root, config } = lab();
  await assert.rejects(executeOfficialRequest(root, config, prepareOfficialRequest(config, { operation: "models" }), {
    fetch: async () => new Response("<html>gateway error</html>", { headers: { "content-type": "application/json" } }),
  }), /非 JSON 响应/u);
  let cancelled = false;
  await assert.rejects(executeOfficialRequest(root, { ...config, timeoutMs: 10 }, prepareOfficialRequest(config, { operation: "models" }), {
    fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }),
  }), /超过 10 ms/u);
  assert.ok(cancelled);
});

test("dry-run redacts a key echoed in custom headers and request body", async () => {
  const { root, config, env } = lab();
  await withEnvAsync(env, async () => {
    const out: string[] = [];
    await runOfficial("responses", { request: JSON.stringify({ input: config.apiKey }), headers: JSON.stringify({ "x-test-value": config.apiKey }), dryRun: true }, {}, { root, stdout: (text) => out.push(text) });
    assert.ok(!out.join("").includes(config.apiKey));
    assert.match(out.join(""), /\*\*\*/u);
    assert.equal(existsSync(path.join(root, "data", "api")), false);
  });
});

test("Files upload rejects non-image content before any network call", () => {
  const { root, config } = lab();
  const file = path.join(root, "image.png");
  writeFileSync(file, "%PDF-1.7 fake image");
  assert.throws(() => prepareOfficialRequest(config, { operation: "files.upload", file }), /按文件内容判断/u);
});

test("explicit gateway base paths survive and overlapping endpoint prefixes are not duplicated", () => {
  const { config } = lab();
  const cases: Array<[string, OfficialOperation, string]> = [
    ["https://example.test/v1", "chat", "https://example.test/v1/chat/completions"],
    ["https://example.test/proxy/v1/", "responses", "https://example.test/proxy/v1/responses"],
    ["https://example.test/proxy/v1", "search", "https://example.test/proxy/v1/tools/search"],
    ["https://example.test/beta", "fim", "https://example.test/beta/completions"],
    ["https://example.test/anthropic/v1", "messages", "https://example.test/anthropic/v1/messages"],
    ["https://example.test/proxy/anthropic", "messages", "https://example.test/proxy/anthropic/v1/messages"],
    ["https://api.deepseek.com/v1", "search", "https://api.deepseek.com/v1/tools/search"],
    ["https://api.deepseek.com/anthropic/v1", "chat", "https://api.deepseek.com/chat/completions"],
  ];
  for (const [baseURL, operation, expected] of cases) assert.equal(prepareOfficialRequest({ ...config, baseURL }, { operation }).url, expected);
  for (const fileId of [".", ".."]) assert.throws(() => prepareOfficialRequest(config, { operation: "files.delete", fileId }), /file_id 不能/u);
});

test("Chat interruption finish reasons fail JSON and SSE even with DONE and preserve partial content", async () => {
  for (const reason of ["aborted", "insufficient_system_resource", "content_filter"]) {
    for (const stream of [false, true]) {
      const { root, config } = lab();
      await assert.rejects(executeOfficialRequest(root, { ...config, maxRetries: 2 }, prepareOfficialRequest(config, { operation: "chat", body: { stream } }), {
        fetch: async () => stream ? streamResponse([
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`,
          'data: [DONE]\n\n',
        ]) : jsonResponse({ choices: [{ message: { content: "partial" }, finish_reason: reason }] }),
      }), new RegExp(`finish_reason=${reason}`, "u"));
      const id = readdirSync(path.join(root, "data", "api"))[0];
      assert.ok(id);
      const dir = path.join(root, "data", "api", id);
      assert.match(readFileSync(path.join(dir, "response.txt"), "utf8"), /partial/u);
      assert.match(readFileSync(path.join(dir, "meta.json"), "utf8"), /"attempts": 1/u);
    }
  }
});
