import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildBenchReport, renderBenchAnalysisCsv, renderBenchAnalysisMarkdown } from "../src/lib/bench/report.ts";
import { renderBenchReport, renderBenchSummary } from "../src/lib/bench/render.ts";
import { benchmarkDir, sampleDir } from "../src/lib/bench/store.ts";
import type { BenchRunRecord, BenchSpec, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";
import { assertMatchesGolden } from "./golden.ts";
import { makeLabRoot, writeJson } from "./helpers.ts";

function subscription(): ResolvedHarnessTarget {
  return { name: "codex-current", kind: "harness",
    definition: { name: "codex-current", kind: "harness", harness: "codex", backend: { auth: "chatgpt", model: "selected-model", reasoningEffort: "high" } },
    profile: { name: "codex", adapter: "codex", executable: "codex", permission: "read-only" },
    backend: { auth: "chatgpt", model: "selected-model", reasoningEffort: "high", codexHome: "/test/codex-home", credentialsStore: "auto" } };
}

function api(): ResolvedHarnessTarget {
  const base = subscription();
  return { ...base, definition: { ...base.definition, backend: { provider: "openai", model: "selected-model", protocol: "responses" } },
    backend: { provider: "openai", model: "selected-model", protocol: "responses", baseURL: "https://example.test/v1", apiKeyEnv: "TEST_API_KEY" } };
}

function spec(target = subscription(), id = "b_0123456789"): BenchSpec {
  return { schemaVersion: 1, id, createdAt: "2026-10-18T00:00:00.000Z", targets: [target], repeat: 1, concurrency: 1,
    task: { name: "answer", prompt: "Reply OK.", timeoutMs: 60000, checks: [{ kind: "output-equals", text: "OK" }] },
    fixture: { hash: "frozen-fixture", files: [] } };
}

function record(s: BenchSpec): BenchRunRecord {
  const target = s.targets[0];
  assert.ok(target);
  return { schemaVersion: 1, target, task: s.task.name, sample: 1, startedAt: s.createdAt,
    workspace: "/test/workspace", home: "/test/home", changes: [], grade: { status: "passed", checks: [] },
    execution: { status: "completed", text: "OK", reasoning: null,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, reasoningTokens: null },
      usageSource: "run-total", cost: null, costSource: null, sessionId: "test-session", responseModel: null,
      events: [], error: null, latencyMs: 2500, exitCode: 0, stdout: "", stderr: "", raw: null, harnessVersion: "codex-test" } };
}

function store(root: string, s: BenchSpec, records: BenchRunRecord[]): void {
  const dir = benchmarkDir(root, s.id);
  writeJson(path.join(dir, "spec.json"), s);
  for (const r of records) writeJson(path.join(sampleDir(dir, r.target.name, r.sample), "record.json"), r);
}

function prices(root: string): string {
  const file = path.join(root, "prices.json");
  writeJson(file, { currency: "USD", verifiedAt: "2026-10-18", sources: [{ title: "Test rates", url: "https://example.test/rates" }],
    models: ["chatgpt", "chatgpt-subscription", "openai"].map((provider) => ({ provider, model: "selected-model",
      scenarios: { test: { inputPerMillion: 100, outputPerMillion: 200 } } })) });
  return file;
}

test("subscription report preserves tokens/time but never prices a subscription with API token rates", () => {
  const root = makeLabRoot();
  const s = spec();
  store(root, s, [record(s)]);
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root) });
  const cell = report.cells[0];
  assert.ok(cell);
  assert.equal(cell.provider, null);
  assert.equal(cell.auth, "chatgpt");
  assert.equal(cell.model, "selected-model");
  assert.equal(cell.metrics.usage.totalTokens, 120);
  assert.equal(cell.metrics.allLatencyMs?.mean, 2500);
  assert.deepEqual(cell.attempts[0]?.estimates, [{ scenario: "test", currency: null, lower: null, upper: null, reason: "subscription" }]);
  assert.equal(cell.metrics.estimatedCosts[0]?.total, null);
  assert.equal(cell.metrics.estimatedCosts[0]?.knownLowerBound, null);
  assert.equal(cell.metrics.estimatedCosts[0]?.perSuccessfulDelivery, null);
  assert.equal(cell.metrics.estimatedCosts[0]?.knownAttempts, 0);
  assert.match(renderBenchAnalysisMarkdown(report), /ChatGPT 订阅/u);
  assert.match(renderBenchAnalysisMarkdown(report), /单次实际费用未知/u);
  const rows = renderBenchAnalysisCsv(report).trimEnd().split("\n").map((line) => line.split(","));
  const headers = rows[0];
  const values = rows[1];
  assert.ok(headers && values);
  assert.equal(values[headers.indexOf("provider")], "");
  assert.equal(values[headers.indexOf("auth")], "chatgpt");
  assert.equal(values[headers.indexOf("totalCost")], "");
  assert.equal(values[headers.indexOf("totalTokens")], "120");
});

test("subscription native zero or API-derived amount is not counted as a per-call charge or free usage", () => {
  const root = makeLabRoot();
  const s = spec();
  s.repeat = 2;
  const zero = record(s);
  zero.execution.cost = { input: 0, output: 0, total: 0, currency: "USD" };
  zero.execution.costSource = "harness-reported";
  const nonzero = structuredClone(zero);
  nonzero.sample = 2;
  nonzero.execution.cost = { input: 1, output: 2, total: 3, currency: "USD" };
  store(root, s, [zero, nonzero]);
  const file = path.join(sampleDir(benchmarkDir(root, s.id), zero.target.name, 1), "record.json");
  const before = readFileSync(file, "utf8");
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root) });
  assert.deepEqual(report.cells[0]?.metrics.nativeCosts, []);
  assert.ok(report.cells[0]?.attempts.every((item) => item.nativeCost === null && item.nativeCostSource === null));
  assert.equal(report.warnings.filter((item) => item.includes("忽略记录中的原生金额")).length, 2);
  assert.equal(readFileSync(file, "utf8"), before);
  const rendered = renderBenchReport(s, [zero, nonzero]);
  assert.match(rendered, /未知（订阅）/u);
  assert.match(rendered, /路由：ChatGPT 订阅/u);
  assert.doesNotMatch(rendered, /0\.000000 USD|3\.000000 USD|undefined/u);
});

test("subscription and API snapshots with the same model remain distinct in suite reports", () => {
  const root = makeLabRoot();
  const subscriptionSpec = spec();
  const apiSpec = spec(api(), "b_abcdef0123");
  apiSpec.task.name = "other";
  store(root, subscriptionSpec, [record(subscriptionSpec)]);
  store(root, apiSpec, [record(apiSpec)]);
  const suiteId = "e_0123456789";
  writeJson(path.join(root, "data", "benchmarks", suiteId, "spec.json"), { schemaVersion: 1, kind: "suite", id: suiteId,
    benchmarks: [subscriptionSpec, apiSpec] });
  const report = buildBenchReport(root, [suiteId], { pricingFile: prices(root) });
  assert.equal(report.balanced.length, 2);
  assert.notEqual(report.cells[0]?.targetHash, report.cells[1]?.targetHash);
  assert.ok(report.balanced.every((item) => !item.comparable));
  assert.equal(report.balanced[0]?.auth, "chatgpt");
  assert.equal(report.balanced[0]?.provider, null);
  assert.equal(report.balanced[0]?.metrics.estimatedCosts[0]?.total, null);
  assert.equal(report.balanced[1]?.auth, undefined);
  assert.equal(report.balanced[1]?.provider, "openai");
  assert.equal(report.balanced[1]?.metrics.estimatedCosts[0]?.total, 0.014);
});

test("missing subscription attempts keep the planned denominator and subscription cost semantics", () => {
  const root = makeLabRoot();
  const s = spec();
  s.repeat = 2;
  store(root, s, [record(s)]);
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root) });
  const cell = report.cells[0];
  assert.equal(cell?.metrics.planned, 2);
  assert.equal(cell?.metrics.passRate, 0.5);
  assert.equal(cell?.metrics.execution.missing, 1);
  assert.equal(cell?.attempts[1]?.estimates[0]?.reason, "subscription");
  assert.equal(cell?.metrics.estimatedCosts[0]?.total, null);
});

test("subscription renderers make the authentication and unknown cost explicit; API rendering stays unchanged", () => {
  const root = makeLabRoot();
  const s = spec();
  const r = record(s);
  store(root, s, [r]);
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root) });
  assertMatchesGolden("bench-codex-subscription-analysis.md", renderBenchAnalysisMarkdown(report));
  assertMatchesGolden("bench-codex-subscription-analysis.csv", renderBenchAnalysisCsv(report));
  assertMatchesGolden("bench-codex-subscription.md", renderBenchReport(s, [r]));
  const legacy = spec(api(), "b_abcdef0123");
  store(root, legacy, [record(legacy)]);
  const oldReport = buildBenchReport(root, [legacy.id], { pricingFile: prices(root) });
  assert.equal(Object.hasOwn(oldReport.cells[0] ?? {}, "auth"), false);
  assert.ok(!renderBenchAnalysisCsv(oldReport).split("\n")[0]?.includes(",auth"));
  assert.doesNotMatch(renderBenchSummary([record(legacy)]), /ChatGPT|订阅/u);
});
