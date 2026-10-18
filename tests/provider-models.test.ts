import assert from "node:assert/strict";
import test from "node:test";
import { listModels } from "../src/lib/provider-models.ts";
import type { ResolvedConfig } from "../src/types.ts";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    name: "test", provider: "openai", baseURL: "https://example.test/v1", model: "demo", temperature: 1,
    maxTokens: 4096, thinking: null, reasoningEffort: null, timeoutMs: 1000, maxRetries: 0,
    apiKey: "test-secret-value", apiKeyEnv: "TEST_KEY", ...overrides,
  };
}

test("model listing preserves OpenAI single-page string/id/name formats and sorts unique IDs", async () => {
  let calls = 0;
  const models = await listModels(config(), { fetch: async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://example.test/v1/models");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-secret-value");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(init?.redirect, "error");
    return Response.json({ data: ["z", { id: "b", owned_by: "owner-b" }, { name: "a", owner: "owner-a" }, { id: "b" }, null, {}], has_more: true });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(models, [{ id: "a", ownedBy: "owner-a" }, { id: "b", ownedBy: "owner-b" }, { id: "z", ownedBy: null }]);
});

test("Anthropic models use native authentication and read all cursor pages without duplicate IDs", async () => {
  const urls: string[] = [];
  const models = await listModels(config({ provider: "anthropic", baseURL: "https://example.test/proxy/v1?limit=2" }), { fetch: async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    assert.equal(url.pathname, "/proxy/v1/models");
    assert.equal(url.searchParams.get("limit"), "2");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "test-secret-value");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.get("authorization"), null);
    if (urls.length === 1) {
      assert.equal(url.searchParams.get("after_id"), null);
      return Response.json({ data: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" });
    }
    assert.equal(url.searchParams.get("after_id"), "claude-opus-5-5");
    return Response.json({ data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }], has_more: false, last_id: "claude-haiku-5-5" });
  } });
  assert.equal(urls.length, 2);
  assert.deepEqual(models.map((model) => model.id), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("official Anthropic hostname selects native models protocol even for an alias provider", async () => {
  await listModels(config({ provider: "alias", baseURL: "https://api.anthropic.com/" }), { fetch: async (input, init) => {
    assert.equal(String(input), "https://api.anthropic.com/v1/models");
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
    return Response.json({ data: [], has_more: false });
  } });
});

test("Anthropic pagination rejects missing or repeated cursors instead of returning a partial list", async () => {
  for (const lastId of [undefined, "", "same-cursor"]) {
    let calls = 0;
    await assert.rejects(listModels(config({ provider: "anthropic" }), { fetch: async () => {
      calls += 1;
      return Response.json({ data: [{ id: "same-cursor" }], has_more: true, ...(lastId === undefined ? {} : { last_id: lastId }) });
    } }), /分页游标缺失或重复/u);
    assert.equal(calls, lastId === "same-cursor" ? 2 : 1);
  }
});

test("Anthropic malformed model responses fail explicitly", async () => {
  await assert.rejects(listModels(config({ provider: "anthropic" }), { fetch: async () => Response.json({ has_more: false }) }), /缺少 data 数组/u);
  await assert.rejects(listModels(config(), { fetch: async () => new Response("invalid JSON") }), /不是有效 JSON/u);
});

test("model listing redacts the API key from HTTP and fetch errors", async () => {
  for (const scenario of ["http", "fetch"]) {
    await assert.rejects(listModels(config(), { fetch: async () => {
      if (scenario === "fetch") throw new Error("failed with test-secret-value");
      return new Response("rejected test-secret-value", { status: 401 });
    } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /test-secret-value/u);
      assert.match(error.message, /\*\*\*/u);
      return true;
    });
  }
});

test("model listing applies timeout to the full pagination operation", async () => {
  await assert.rejects(listModels(config({ timeoutMs: 5 }), { fetch: async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new Error("aborted test-secret-value")); }, { once: true });
    });
  } }), /列出模型超时（5 ms）/u);
});

test("model listing rejects credential-bearing base URLs before calling fetch", async () => {
  let called = false;
  await assert.rejects(listModels(config({ baseURL: "https://user:test-secret-value@example.test/v1" }), { fetch: async () => {
    called = true;
    return Response.json({ data: [] });
  } }), /不含用户名和密码/u);
  assert.equal(called, false);
});
