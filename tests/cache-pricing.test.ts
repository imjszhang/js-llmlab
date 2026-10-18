import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseNamedConfig, peekConfigRef } from "../src/lib/config.ts";
import { computeCost } from "../src/lib/cost.ts";
import {
  parseComparisonSpec,
  parseComparisonVariant,
  parsePricingRecord,
  parseSessionNode,
  parseUsage,
} from "../src/lib/parse.ts";
import { renderComparisonReport, renderTurn, renderVariantMarkdown, renderVariantRun } from "../src/lib/render.ts";
import { runFromNode, variantFromRuns, variantRuns } from "../src/lib/runs.ts";
import { LabStore } from "../src/lib/store.ts";
import type { ComparisonSpec, Pricing, TokenUsage } from "../src/types.ts";
import { makeCommandLab, withEnv, writeJson } from "./helpers.ts";

const usage: TokenUsage = {
  promptTokens: 1_000,
  completionTokens: 500,
  totalTokens: 1_500,
  reasoningTokens: 200,
};

const pricing: Pricing = {
  inputPerMillion: 2,
  cachedInputPerMillion: 0.04,
  outputPerMillion: 8,
  currency: "CNY",
};

function oldNodeData(): Record<string, unknown> {
  return {
    id: "n_cache",
    parentId: null,
    createdAt: "2026-10-17T00:00:00.000Z",
    config: {
      name: "official",
      provider: "deepseek",
      baseURL: "https://example.test/v1",
      model: "deepseek-flash",
      temperature: 1,
      maxTokens: 4_096,
    },
    systemPreset: null,
    userPreset: null,
    messages: { system: "", user: "q", assistant: "a", reasoning: null },
    usage,
    latencyMs: 1,
    error: null,
  };
}

test("缓存成本：命中与普通输入分开算，缺命中数或命中价保持原输入价", () => {
  const cached = computeCost({ ...usage, promptCacheHitTokens: 800, promptCacheMissTokens: 200 }, pricing);
  assert.ok(cached);
  assert.ok(Math.abs(cached.input - 0.000432) < 1e-12);
  assert.ok(Math.abs(cached.output - 0.004) < 1e-12);
  assert.ok(Math.abs(cached.total - 0.004432) < 1e-12);
  // 已知 hit 时，可从总输入扣除；没有 miss 不会漏计剩余输入。
  assert.deepEqual(computeCost({ ...usage, promptCacheHitTokens: 800 }, pricing), cached);
  // 仅返回 miss 不代表其余输入都可享受折扣。
  assert.equal(computeCost({ ...usage, promptCacheMissTokens: 200 }, pricing)?.input, 0.002);
  assert.equal(computeCost(usage, pricing)?.input, 0.002);
  assert.equal(computeCost({ ...usage, promptCacheHitTokens: 800 }, {
    inputPerMillion: 2, outputPerMillion: 8, currency: "CNY",
  })?.input, 0.002);
  assert.equal(computeCost({ ...usage, promptCacheHitTokens: 1_000 }, {
    ...pricing, cachedInputPerMillion: 0,
  })?.input, 0);
});

test("缓存计数：解析拒绝非法与超过输入的计数，成本计算对异常实时数据安全回退", () => {
  for (const value of [-1, 0.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY, "800"]) {
    assert.throws(() => parseUsage({ ...usage, promptCacheHitTokens: value }), /promptCacheHitTokens/);
    assert.throws(() => parseUsage({ ...usage, promptCacheMissTokens: value }), /promptCacheMissTokens/);
  }
  assert.throws(() => parseUsage({ ...usage, promptCacheHitTokens: 800, promptCacheMissTokens: 300 }), /总和/);
  assert.equal(computeCost({ ...usage, promptCacheHitTokens: 1_001 }, pricing)?.input, 0.002);
  assert.equal(computeCost({ ...usage, promptCacheHitTokens: 800, promptCacheMissTokens: 300 }, pricing)?.input, 0.002);
  assert.deepEqual(parseUsage({ ...usage, promptCacheHitTokens: 0, promptCacheMissTokens: 1_000 }), {
    ...usage, promptCacheHitTokens: 0, promptCacheMissTokens: 1_000,
  });
  assert.deepEqual(parseUsage({ ...usage, promptCacheHitTokens: null, promptCacheMissTokens: null }), usage);
});

test("命中价：provider 可继承，config 整体覆盖，快照保留零价并拒绝非法值", () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "cache.json"), {
    name: "cache",
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_KEY",
    model: "demo",
    pricing,
  });
  writeJson(path.join(root, "configs", "inherit-cache.json"), { name: "inherit-cache", provider: "cache" });
  writeJson(path.join(root, "configs", "override-cache.json"), {
    name: "override-cache", provider: "cache", pricing: { inputPerMillion: 1, outputPerMillion: 2 },
  });
  withEnv(env, () => {
    assert.deepEqual(peekConfigRef(root, "inherit-cache").snapshot.pricing, pricing);
    assert.deepEqual(peekConfigRef(root, "override-cache").snapshot.pricing, {
      inputPerMillion: 1, outputPerMillion: 2, currency: "CNY",
    });
  });
  assert.equal(parsePricingRecord({ ...pricing, cachedInputPerMillion: 0 })?.cachedInputPerMillion, 0);
  for (const value of [-0.01, "free", Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseNamedConfig({ pricing: { ...pricing, cachedInputPerMillion: value } }), /cachedInputPerMillion/);
    assert.throws(() => parsePricingRecord({ ...pricing, cachedInputPerMillion: value }), /cachedInputPerMillion/);
  }
});

test("旧节点与旧对比没有缓存、实际模型或高级请求字段，渲染保持兼容", () => {
  const node = parseSessionNode(oldNodeData());
  assert.equal("responseModel" in node, false);
  assert.equal("apiMessages" in node.messages, false);
  assert.deepEqual(node.usage, usage);
  assert.doesNotMatch(renderTurn(node), /responseModel|promptCache/);
  assert.equal("responseModel" in runFromNode(node), false);
  assert.throws(() => parseSessionNode({ ...oldNodeData(), responseModel: 1 }), /responseModel/);
  for (const apiMessages of [null, {}, ["bad"], [null]]) {
    assert.throws(() => parseSessionNode({
      ...oldNodeData(), messages: { system: "", user: "q", assistant: "a", apiMessages },
    }), /apiMessages/);
  }
});

test("持久化：缓存统计、实际响应版本、多模态和工具历史、补跑扩展请求往返不丢字段", () => {
  const { root } = makeCommandLab();
  const store = new LabStore(root);
  const session = store.createSession({ title: "metadata", defaultConfig: "official", defaultSystem: null });
  const apiMessages = [
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
    { role: "assistant", content: null, reasoning_content: "reason", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "tool result", vendor_field: true },
    { role: "assistant", content: "a", reasoning_content: "done" },
  ];
  const node = parseSessionNode({
    ...oldNodeData(),
    responseModel: "DeepSeek-V4.1-Flash-1017",
    config: { name: "official", provider: "deepseek", baseURL: "https://example.test/v1", model: "deepseek-flash", temperature: 1, maxTokens: 4_096, pricing },
    messages: { system: "", user: "q", assistant: "a", reasoning: "done", apiMessages },
    usage: { ...usage, promptCacheHitTokens: 800, promptCacheMissTokens: 200 },
  });
  node.cost = computeCost(node.usage, node.config.pricing);
  store.writeNode(session.id, node);
  assert.deepEqual(store.getNode(session.id, node.id), node);
  const run = runFromNode(node);
  const variant = variantFromRuns("official", node.config, [run, { ...run, responseModel: "revision-2" }]);
  assert.deepEqual(parseComparisonVariant(JSON.parse(JSON.stringify(variant))), variant);
  assert.equal(variantRuns(variant)[1]?.responseModel, "revision-2");
  assert.equal(variantRuns(variantFromRuns("official", node.config, [run]))[0]?.responseModel, node.responseModel);
  const spec: ComparisonSpec = {
    id: "c_cache", createdAt: node.createdAt, configs: ["official"], systemPreset: null,
    userPreset: null, input: "q", sessionId: session.id, fromNodeId: null,
    request: { response_format: { type: "json_object" }, tools: [{ type: "function", function: { name: "read" } }] },
  };
  store.writeComparison(spec, [variant], renderComparisonReport(spec, [variant]));
  assert.deepEqual(parseComparisonSpec(JSON.parse(JSON.stringify(spec))), spec);
  assert.deepEqual(store.readComparison(spec.id).spec.request, spec.request);
  assert.equal(store.readComparison(spec.id).variants[0]?.responseModel, node.responseModel);
  assert.throws(() => parseComparisonSpec({ ...spec, request: [] }), /spec.request/);
  const turn = readFileSync(path.join(root, "data", "sessions", session.id, "turns", `${node.id}.md`), "utf8");
  assert.match(turn, /- responseModel: DeepSeek-V4\.1-Flash-1017/);
  assert.match(turn, /- promptCacheHitTokens: 800/);
  assert.match(turn, /- promptCacheMissTokens: 200/);
  assert.match(renderVariantMarkdown(variant), /- responseModel: DeepSeek-V4\.1-Flash-1017/);
  assert.match(renderVariantRun(variant, run, 1), /- promptCacheHitTokens: 800/);
});
