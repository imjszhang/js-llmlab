import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerTokens,
  renderComparisonReport,
  renderSummaryTable,
  renderTurn,
  renderVariantMarkdown,
  renderVariantReasoning,
} from "../src/lib/render.ts";
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
    timeoutMs: 600000,
    maxRetries: 2,
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
  cost: null,
  requestId: null,
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
      cost: null,
      requestId: null,
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
      cost: null,
      requestId: null,
    },
  ];
  const report = renderComparisonReport(spec, variants);
  assert.match(report, /## 汇总/);
  assert.match(report, /## default/);
  assert.match(report, /## deepseek/);
  assert.match(report, /答案 A/);
  assert.match(report, /答案 B/);
  assert.match(report, /同一道题/);
  assert.doesNotMatch(report, /apiKey|sk-/u);
  // 汇总在 Input 之前，成稿在 Input 之后
  assert.ok(report.indexOf("## 汇总") < report.indexOf("## Input"));
  assert.ok(report.indexOf("## Input") < report.indexOf("## default"));
});

test("汇总表：行序 = 输入顺序，耗时 1 位小数，缺失为 -，错误截断 60 字", () => {
  const longError = "x".repeat(80);
  const variants: ComparisonVariant[] = [
    {
      configName: "slow|pipe",
      config: { ...node.config, thinking: "enabled", reasoningEffort: "max" },
      assistant: "A",
      reasoning: "想",
      usage: { promptTokens: 100, completionTokens: 350, totalTokens: 450, reasoningTokens: 300 },
      latencyMs: 12345,
      error: null,
      nodeId: "n_a",
      cost: null,
      requestId: null,
    },
    {
      configName: "broken",
      config: node.config,
      assistant: "",
      reasoning: null,
      usage: null,
      latencyMs: 0,
      error: longError,
      nodeId: "n_b",
      cost: null,
      requestId: null,
    },
  ];
  const table = renderSummaryTable(variants);
  const rows = table.split("\n");
  assert.equal(rows.length, 4);
  assert.equal(rows[0], "| 配置 | provider | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 成本 | 错误 |");
  assert.equal(rows[2], "| slow\\|pipe | llmcore | deepseek-chat | enabled | max | 12.3 | 300 | 50 | 450 | - | - |");
  assert.equal(rows[3], `| broken | llmcore | deepseek-chat | - | - | 0.0 | - | - | - | - | ${"x".repeat(59)}… |`);
  assert.equal(answerTokens(variants[0] ?? variants[1]!), 50);
  assert.equal(answerTokens(variants[1]!), null);

  const report = renderComparisonReport(
    {
      id: "c_two",
      createdAt: "2026-09-11T00:00:00.000Z",
      configs: ["slow|pipe", "broken"],
      systemPreset: null,
      userPreset: null,
      input: "q",
      sessionId: null,
      fromNodeId: null,
    },
    variants,
  );
  assert.doesNotMatch(report, /### Reasoning/);
  assert.doesNotMatch(report, /想/);
  assert.match(report, /> error: x{80}/);

  const output = renderVariantMarkdown(variants[0]!);
  assert.doesNotMatch(output, /想/);
  assert.match(output, /^A$/m);
  const reasoning = renderVariantReasoning(variants[0]!);
  assert.match(reasoning, /^# Reasoning slow\|pipe/);
  assert.match(reasoning, /^想$/m);
  assert.doesNotMatch(reasoning, /^A$/m);
});
