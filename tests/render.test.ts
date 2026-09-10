import assert from "node:assert/strict";
import { test } from "node:test";
import { renderComparisonReport, renderTurn } from "../src/lib/render.ts";
import type { ComparisonSpec, ComparisonVariant, SessionNode } from "../src/types.ts";

const node: SessionNode = {
  id: "n_one",
  parentId: null,
  createdAt: "2026-09-11T00:00:00.000Z",
  config: {
    name: "deepseek",
    provider: "llmcore",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    temperature: 0.3,
    maxTokens: 4096,
    thinking: null,
    reasoningEffort: null,
  },
  systemPreset: "default",
  userPreset: "hello",
  messages: {
    system: "sys",
    user: "你好",
    assistant: "您好",
    reasoning: null,
  },
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, reasoningTokens: null },
  latencyMs: 20,
  error: null,
};

test("turn markdown 含正文且不含密钥字段", () => {
  const md = renderTurn(node);
  assert.match(md, /你好/);
  assert.match(md, /您好/);
  assert.match(md, /deepseek-chat/);
  assert.doesNotMatch(md, /apiKey|OPENAI_API_KEY|sk-/u);
});

test("对比报告并排两套配置", () => {
  const spec: ComparisonSpec = {
    id: "c_one",
    createdAt: "2026-09-11T00:00:00.000Z",
    configs: ["default", "deepseek"],
    systemPreset: "default",
    userPreset: null,
    input: "同一道题",
    sessionId: "s_one",
    fromNodeId: null,
  };
  const variants: ComparisonVariant[] = [
    {
      configName: "default",
      config: { ...node.config, name: "default", model: "gpt-4o-mini" },
      assistant: "答案 A",
      reasoning: null,
      usage: null,
      latencyMs: 10,
      error: null,
      nodeId: "n_a",
    },
    {
      configName: "deepseek",
      config: node.config,
      assistant: "答案 B",
      reasoning: null,
      usage: null,
      latencyMs: 11,
      error: null,
      nodeId: "n_b",
    },
  ];
  const report = renderComparisonReport(spec, variants);
  assert.match(report, /## default/);
  assert.match(report, /## deepseek/);
  assert.match(report, /答案 A/);
  assert.match(report, /答案 B/);
  assert.match(report, /同一道题/);
  assert.doesNotMatch(report, /apiKey|sk-/u);
});
