import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBenchReport, renderBenchSummary } from "../src/lib/bench/render.ts";
import type { BenchRunRecord, BenchSpec, ResolvedHarnessTarget, ResolvedLlmTarget } from "../src/lib/bench/types.ts";
import { assertMatchesGolden } from "./golden.ts";

test("bench report distinguishes execution and acceptance, records versions, unknown usage and total-only cost", () => {
  const direct: ResolvedLlmTarget = {
    name: "direct", kind: "llm", definition: { name: "direct", kind: "llm", config: "demo" }, apiKeyEnv: "TEST_KEY", systemText: "Be concise.",
    config: { name: "demo", provider: "test", baseURL: "https://example.test/v1", model: "model-a", temperature: 1, maxTokens: 64, thinking: null, reasoningEffort: null, timeoutMs: 1000, maxRetries: 0 },
  };
  const agent: ResolvedHarnessTarget = {
    name: "agent", kind: "harness", definition: { name: "agent", kind: "harness", harness: "claude-code", backend: { provider: "test", model: "model-b", protocol: "anthropic-messages" } },
    profile: { name: "claude-code", adapter: "claude-code", executable: "claude", permission: "workspace-write" },
    backend: { provider: "test", model: "model-b", protocol: "anthropic-messages", baseURL: "https://example.test", apiKeyEnv: "TEST_KEY" },
  };
  const first: BenchRunRecord = {
    schemaVersion: 1, target: direct, task: "demo", sample: 1, startedAt: "2026-10-17T00:00:00.000Z", workspace: "/example/workspace", home: "/example/home",
    execution: { status: "completed", text: "OK", reasoning: null, usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10, reasoningTokens: null }, cost: { input: 0.01, output: 0.02, total: 0.03, currency: "CNY" },
      sessionId: null, responseModel: "model-a", events: [], error: null, latencyMs: 1200, exitCode: null, stdout: "OK", stderr: "", raw: null, harnessVersion: null, usageSource: "request", costSource: "configured-pricing" },
    grade: { status: "passed", checks: [{ check: { kind: "output-contains", text: "OK" }, passed: true, detail: "输出包含指定文本" }] }, changes: [],
  };
  const second: BenchRunRecord = { ...first, target: agent,
    execution: { ...first.execution, latencyMs: 2345, cost: { input: null, output: null, total: 0.12, currency: "USD" }, harnessVersion: "claude-test 1.0", usageSource: "run-total", costSource: "harness-reported" },
    grade: { status: "failed", checks: [{ check: { kind: "file-exists", path: "result.txt" }, passed: false, detail: "文件不存在" }] },
    changes: [{ path: "other.txt", kind: "added", before: null, after: "1234" }],
  };
  const third: BenchRunRecord = { ...second, sample: 2,
    execution: { ...second.execution, status: "timeout", usage: null, cost: null, costSource: null, latencyMs: 5000, error: "time | out\npartial" },
    grade: { status: "not-run", checks: [] }, changes: [],
  };
  const spec: BenchSpec = { schemaVersion: 1, id: "b_0123456789", createdAt: first.startedAt,
    task: { name: "demo", prompt: "Reply OK, then write result.txt.", timeoutMs: 5000, checks: [] }, targets: [direct, agent], repeat: 2, concurrency: 2, fixture: { hash: "fixture-test-hash", files: [] } };
  const records = [first, second, third];
  const summary = renderBenchSummary(records);
  assert.match(summary, /completed \| failed/u);
  assert.match(summary, /timeout \| not-run \| 5.00 \| - \| -/u);
  assertMatchesGolden("bench-report.md", renderBenchReport(spec, records));
});
