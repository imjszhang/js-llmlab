import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runOnce } from "../src/commands/run.ts";
import { parseNamedConfig, peekConfigRef, toSnapshot } from "../src/lib/config.ts";
import { computeCost, formatCost } from "../src/lib/cost.ts";
import { parseSessionNode } from "../src/lib/parse.ts";
import { renderSummaryTable } from "../src/lib/render.ts";
import { LabStore } from "../src/lib/store.ts";
import type { ComparisonVariant } from "../src/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnv, withEnvAsync, writeJson } from "./helpers.ts";

const silent = (): void => {};

test("computeCost：输入 2 / 输出 8 每百万，usage 1000 / 500 → total 0.006；无 pricing 为 null", () => {
  const usage = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, reasoningTokens: 200 };
  const cost = computeCost(usage, { inputPerMillion: 2, outputPerMillion: 8, currency: "CNY" });
  assert.ok(cost);
  assert.ok(Math.abs(cost.input - 0.002) < 1e-9);
  assert.ok(Math.abs(cost.output - 0.004) < 1e-9);
  assert.ok(Math.abs(cost.total - 0.006) < 1e-9);
  assert.equal(cost.currency, "CNY");
  assert.equal(computeCost(usage, undefined), null);
  assert.equal(computeCost(null, { inputPerMillion: 2, outputPerMillion: 8, currency: "CNY" }), null);
  assert.equal(formatCost(cost), "0.0060 CNY");
  assert.equal(formatCost({ input: 1, output: 0.5, total: 1.5, currency: "USD" }), "1.50 USD");
  assert.equal(formatCost(null), "-");
});

test("pricing 解析：config 覆盖 provider；只写 provider 也生效；非法值报错", () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "priced.json"), {
    name: "priced",
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_KEY",
    model: "demo",
    pricing: { inputPerMillion: 1, outputPerMillion: 4 },
  });
  writeJson(path.join(root, "configs", "inherit.json"), { name: "inherit", provider: "priced", model: "m1" });
  writeJson(path.join(root, "configs", "override.json"), {
    name: "override",
    provider: "priced",
    model: "m2",
    pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: "USD" },
  });

  withEnv(env, () => {
    const inherit = peekConfigRef(root, "inherit").snapshot;
    assert.deepEqual(inherit.pricing, { inputPerMillion: 1, outputPerMillion: 4, currency: "CNY" });
    const override = peekConfigRef(root, "override").snapshot;
    assert.deepEqual(override.pricing, { inputPerMillion: 2, outputPerMillion: 8, currency: "USD" });
    const plain = peekConfigRef(root, "a").snapshot;
    assert.equal("pricing" in plain, false);
    // 快照往返：无 pricing 时不出现 key
    assert.equal("pricing" in toSnapshot({ ...plain, apiKey: "sk-x", apiKeyEnv: "TEST_KEY" }), false);
    assert.deepEqual(toSnapshot({ ...override, apiKey: "sk-x", apiKeyEnv: "TEST_KEY" }).pricing, override.pricing);
  });

  assert.throws(() => parseNamedConfig({ pricing: { inputPerMillion: -1, outputPerMillion: 1 } }), /≥ 0/);
  assert.throws(() => parseNamedConfig({ pricing: "cheap" }), /pricing 必须是对象/);
  assert.equal(parseNamedConfig({ pricing: null }).pricing, undefined);
});

test("旧节点没有 cost 字段时读出为 null；旧配置快照没有 pricing", () => {
  const node = parseSessionNode({
    id: "n_old",
    parentId: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    config: { name: "x", baseURL: "https://example.test", model: "m", temperature: 1, maxTokens: 10 },
    systemPreset: null,
    userPreset: null,
    messages: { system: "", user: "u", assistant: "a" },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 5,
    error: null,
  });
  assert.equal(node.cost, null);
  assert.equal("pricing" in node.config, false);
});

test("run 落盘的节点带 cost，turn md 与汇总表显示成本", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "configs", "priced.json"), {
    name: "priced",
    provider: "test",
    model: "model-p",
    pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: "CNY" },
  });
  const fake = createFakeCompleter({
    priced: {
      text: "ok",
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, reasoningTokens: 0 },
    },
  });
  await withEnvAsync(env, () => runOnce({ config: "priced", message: "q" }, { root, complete: fake.complete, log: silent }));

  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const node = store.listNodes(sessionId)[0];
  assert.ok(node);
  assert.ok(node.cost);
  assert.ok(Math.abs(node.cost.total - 0.006) < 1e-9);
  const turn = readFileSync(path.join(root, "data", "sessions", sessionId, "turns", `${node.id}.md`), "utf8");
  assert.match(turn, /- cost: 0\.0060 CNY/);

  const variant: ComparisonVariant = {
    configName: "priced",
    config: node.config,
    assistant: node.messages.assistant,
    reasoning: null,
    usage: node.usage,
    latencyMs: node.latencyMs,
    error: null,
    nodeId: node.id,
    cost: node.cost,
    requestId: null,
  };
  const table = renderSummaryTable([variant, { ...variant, configName: "free", cost: null }]);
  assert.match(table, /\| priced \| model-p \| .* \| 1500 \| 0\.0060 CNY \| - \|/);
  assert.match(table, /\| free \| model-p \| .* \| 1500 \| - \| - \|/);
});
