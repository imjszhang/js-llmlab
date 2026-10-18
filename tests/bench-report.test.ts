import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildBenchReport, readBenchReportPrices, renderBenchAnalysisCsv, renderBenchAnalysisMarkdown } from "../src/lib/bench/report.ts";
import type { ReportPrices } from "../src/lib/bench/report-types.ts";
import { benchmarkDir, sampleDir } from "../src/lib/bench/store.ts";
import type { BenchRunRecord, BenchSpec, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";
import { assertMatchesGolden } from "./golden.ts";
import { makeLabRoot, writeJson } from "./helpers.ts";

function target(name = "agent", model = "model-a"): ResolvedHarnessTarget {
  return { name, kind: "harness", definition: { name, kind: "harness", harness: "claude-code", backend: { provider: "test", model, protocol: "anthropic-messages" } },
    profile: { name: "claude-code", adapter: "claude-code", executable: "claude", permission: "workspace-write" },
    backend: { provider: "test", model, protocol: "anthropic-messages", baseURL: "https://example.test/anthropic", apiKeyEnv: "TEST_KEY" } };
}

function spec(id = "b_0123456789", task = "demo", repeat = 3): BenchSpec {
  return { schemaVersion: 1, id, createdAt: "2026-10-18T00:00:00.000Z",
    task: { name: task, prompt: "Write the correct answer.", timeoutMs: 5000, checks: [{ kind: "output-contains", text: "OK" }] },
    targets: [target()], repeat, concurrency: 2, fixture: { hash: "frozen-fixture", files: [] } };
}

function record(s: BenchSpec, sample: number, passed = true): BenchRunRecord {
  const t = s.targets[0];
  assert.ok(t);
  return { schemaVersion: 1, target: t, task: s.task.name, sample, startedAt: s.createdAt, workspace: "/old/workspace", home: "/old/home", changes: [],
    execution: { status: "completed", text: "OK", reasoning: null,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, reasoningTokens: 15, promptCacheHitTokens: 80 },
      cost: { input: null, output: null, total: 55, currency: "USD" }, sessionId: "native-session", responseModel: null, events: [], error: null,
      latencyMs: sample * 1000, exitCode: 0, stdout: "", stderr: "", raw: null, harnessVersion: "claude-test 1.0", usageSource: "run-total", costSource: "harness-reported" },
    grade: { status: passed ? "passed" : "failed", checks: [] } };
}

function store(root: string, s: BenchSpec, records: BenchRunRecord[]): void {
  const dir = benchmarkDir(root, s.id);
  writeJson(path.join(dir, "spec.json"), s);
  for (const r of records) writeJson(path.join(sampleDir(dir, r.target.name, r.sample), "record.json"), r);
}

function prices(root: string, extra: ReportPrices["models"] = []): string {
  const file = path.join(root, "prices.json");
  writeJson(file, { currency: "CNY", verifiedAt: "2026-10-18", sources: [{ title: "Maintained rate sheet", url: "https://example.test/pricing" }],
    models: [{ provider: "test", model: "model-a", scenarios: { offPeak: { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 },
      peak: { inputPerMillion: 4, cachedInputPerMillion: 0.4, outputPerMillion: 20 } } }, ...extra] });
  return file;
}

function suite(root: string, specs: BenchSpec[], id = "e_0123456789"): string {
  writeJson(path.join(root, "data", "benchmarks", id, "spec.json"), { schemaVersion: 1, kind: "suite", id, createdAt: "2026-10-18T00:00:00.000Z",
    name: "test-suite", repeat: 3, concurrency: 2, benchmarks: specs, schedule: [] });
  return id;
}

test("offline report accepts legacy schema, counts planned missing samples, and never reads current task/target files", () => {
  const root = makeLabRoot();
  const s = spec();
  const r = record(s, 1);
  const old = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
  const execution = old.execution;
  assert.ok(typeof execution === "object" && execution !== null);
  Reflect.deleteProperty(execution, "usageSource");
  Reflect.deleteProperty(execution, "costSource");
  store(root, s, []);
  writeJson(path.join(sampleDir(benchmarkDir(root, s.id), "agent", 1), "record.json"), old);
  rmSync(path.join(root, "configs"), { recursive: true });
  rmSync(path.join(root, "providers"), { recursive: true });
  const report = buildBenchReport(root, [s.id, s.id]);
  assert.deepEqual(report.benchmarkIds, [s.id]);
  const cell = report.cells[0];
  assert.ok(cell);
  assert.equal(cell.metrics.planned, 3);
  assert.equal(cell.metrics.recorded, 1);
  assert.equal(cell.metrics.execution.missing, 2);
  assert.equal(cell.metrics.grade.missing, 2);
  assert.equal(cell.metrics.passRate, 1 / 3);
  assert.equal(cell.attempts[0]?.usageSource, null);
  assert.equal(cell.metrics.usage.known, 1);
  assert.equal(cell.metrics.estimatedCosts.length, 0);
  assert.ok(report.warnings.some((value) => value.includes("去重")));
});

test("recalculation prices cached/uncached/output once, includes failed attempts, and ignores harness USD estimates", () => {
  const root = makeLabRoot();
  const s = spec(undefined, undefined, 2);
  const first = record(s, 1);
  const failed = record(s, 2, false);
  store(root, s, [first, failed]);
  const file = path.join(sampleDir(benchmarkDir(root, s.id), "agent", 1), "record.json");
  const before = readFileSync(file, "utf8");
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root), scenario: "offPeak" });
  const result = report.cells[0]?.metrics.estimatedCosts[0];
  assert.ok(result);
  assert.ok(Math.abs((result.total ?? 0) - 0.000512) < 1e-12);
  assert.ok(Math.abs((result.perSuccessfulDelivery?.lower ?? 0) - 0.000512) < 1e-12);
  assert.ok(Math.abs((result.meanPerAttempt?.lower ?? 0) - 0.000256) < 1e-12);
  assert.equal(report.cells[0]?.metrics.nativeCosts[0]?.knownTotal, 110);
  assert.equal(report.cells[0]?.metrics.nativeCosts[0]?.currency, "USD");
  assert.equal(report.cells[0]?.metrics.usage.completionTokens, 40);
  assert.equal(report.pricing?.scenarios.length, 1);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("unknown cache yields an interval; unknown usage and missing attempts retain only a known lower bound", () => {
  const root = makeLabRoot();
  const s = spec();
  const one = record(s, 1);
  assert.ok(one.execution.usage);
  delete one.execution.usage.promptCacheHitTokens;
  const two = record(s, 2);
  two.execution.status = "timeout";
  two.execution.usage = null;
  two.grade.status = "not-run";
  store(root, s, [one, two]);
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root), scenario: "offPeak" });
  const cell = report.cells[0];
  assert.ok(cell);
  assert.equal(cell.attempts[0]?.estimates[0]?.reason, "cache-unknown");
  assert.ok(Math.abs((cell.attempts[0]?.estimates[0]?.lower ?? 0) - 0.00022) < 1e-12);
  assert.ok(Math.abs((cell.attempts[0]?.estimates[0]?.upper ?? 0) - 0.0004) < 1e-12);
  const cost = cell.metrics.estimatedCosts[0];
  assert.equal(cost?.knownAttempts, 1);
  assert.equal(cost?.total, null);
  assert.equal(cost?.upperBound, null);
  assert.equal(cost?.perSuccessfulDelivery, null);
  assert.equal(cost?.meanPerAttempt, null);
  assert.equal(cell.metrics.execution.timeout, 1);
  assert.equal(cell.metrics.execution.missing, 1);
  const csv = renderBenchAnalysisCsv(report);
  assert.match(csv, /knownCostLowerBound,totalCost,costUpperBound/u);
});

test("all-cache-unknown attempts report bounded delivery cost; a missing cached price means a uniform input price", () => {
  const root = makeLabRoot();
  const s = spec(undefined, undefined, 1);
  const r = record(s, 1);
  assert.ok(r.execution.usage);
  delete r.execution.usage.promptCacheHitTokens;
  store(root, s, [r]);
  const file = prices(root);
  const interval = buildBenchReport(root, [s.id], { pricingFile: file }).cells[0]?.metrics.estimatedCosts[0];
  assert.equal(interval?.exactAttempts, 0);
  assert.ok(interval?.perSuccessfulDelivery);
  assert.equal(interval?.total, null);
  writeJson(file, { currency: "CNY", verifiedAt: "2026-10-18", sources: [{ title: "price", url: "https://example.test" }],
    models: [{ provider: "test", model: "model-a", scenarios: { uniform: { inputPerMillion: 2, outputPerMillion: 10 } } }] });
  const uniform = buildBenchReport(root, [s.id], { pricingFile: file });
  assert.equal(uniform.cells[0]?.attempts[0]?.estimates[0]?.reason, "exact");
  assert.equal(uniform.cells[0]?.metrics.estimatedCosts[0]?.total, 0.0004);
});

test("pricing requires exact provider/model matching, keeps currencies separate, and snapshots its evidence", () => {
  const root = makeLabRoot();
  const s = spec(undefined, undefined, 1);
  s.targets.push(target("other", "model-b"), target("alias", "model-a-alias"));
  const r = record(s, 1);
  store(root, s, [r, { ...r, target: target("other", "model-b") }, { ...r, target: target("alias", "model-a-alias") }]);
  const file = prices(root, [{ provider: "test", model: "model-b", currency: "USD", scenarios: { offPeak: { inputPerMillion: 1, outputPerMillion: 3 } } }]);
  const report = buildBenchReport(root, [s.id], { pricingFile: file });
  assert.equal(report.cells[0]?.metrics.estimatedCosts[0]?.currency, "CNY");
  assert.equal(report.cells[1]?.metrics.estimatedCosts[0]?.currency, "USD");
  assert.equal(report.cells[2]?.attempts[0]?.estimates[0]?.reason, "unpriced");
  assert.equal(report.cells[2]?.metrics.estimatedCosts[0]?.knownLowerBound, null);
  assert.equal(report.pricing?.snapshot.sources[0]?.url, "https://example.test/pricing");
  assert.match(report.pricing?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.throws(() => buildBenchReport(root, [s.id], { pricingFile: file, scenario: "guessed" }), /没有情景/u);
  assert.throws(() => buildBenchReport(root, [s.id], { scenario: "peak" }), /需要/u);
});

test("suite report expands frozen parent plans, deduplicates explicit children, and counts absent child files", () => {
  const root = makeLabRoot();
  const first = spec();
  const second = spec("b_abcdef0123", "another");
  store(root, first, [record(first, 1)]);
  const id = suite(root, [first, second]);
  const report = buildBenchReport(root, [first.id, id]);
  assert.deepEqual(report.benchmarkIds, [first.id, second.id]);
  assert.equal(report.cohorts.length, 1);
  assert.equal(report.cells[1]?.metrics.execution.missing, 3);
  assert.equal(report.balanced[0]?.metrics.planned, 6);
  assert.equal(report.balanced[0]?.metrics.recorded, 1);
  assert.equal(report.balanced[0]?.equalTaskPassRate, (1 / 3) / 2);
  assert.equal(report.balanced[0]?.equalTaskMeanLatencyMs, null);
  assert.ok(report.warnings.some((value) => value.includes("尚未落盘")));
});

test("suite equal-task statistics do not weight tasks by their number of repeats", () => {
  const root = makeLabRoot();
  const first = spec(undefined, "short", 1);
  const second = spec("b_abcdef0123", "long", 3);
  const r = record(first, 1);
  store(root, first, [r]);
  store(root, second, [record(second, 1, false), record(second, 2, false), record(second, 3, false)]);
  const report = buildBenchReport(root, [suite(root, [first, second])], { pricingFile: prices(root) });
  const combined = report.balanced[0];
  assert.equal(combined?.comparable, true);
  assert.equal(combined?.metrics.passRate, 1 / 4);
  assert.equal(combined?.equalTaskPassRate, 1 / 2);
  assert.equal(combined?.equalTaskMeanLatencyMs, 1500);
  assert.ok(combined?.equalTaskEstimatedCosts[0]?.meanPerAttempt);
});

test("different budgets, checker/prompt revisions, concurrent loads, target settings and versions are never silently ranked", () => {
  const root = makeLabRoot();
  const first = spec(undefined, "same", 1);
  const second = spec("b_abcdef0123", "same", 1);
  second.task.timeoutMs = 10000;
  second.task.prompt = "New prompt";
  store(root, first, [record(first, 1)]);
  store(root, second, [record(second, 1)]);
  const bare = buildBenchReport(root, [first.id, second.id]);
  assert.equal(bare.cohorts.length, 2);
  assert.equal(bare.balanced.length, 0);
  assert.notEqual(bare.cells[0]?.taskHash, bare.cells[1]?.taskHash);
  const changedTask = buildBenchReport(root, [suite(root, [first, second])]);
  assert.equal(changedTask.balanced[0]?.comparable, false);
  second.task.name = "new-task";
  second.targets[0] = target("agent", "model-b");
  second.concurrency = 5;
  const r = record(second, 1);
  r.execution.harnessVersion = "claude-test 2.0";
  store(root, second, [r]);
  const changedTarget = buildBenchReport(root, [suite(root, [first, second])]);
  assert.equal(changedTarget.balanced.length, 2);
  assert.ok(changedTarget.balanced.every((value) => !value.comparable));
  assert.notEqual(changedTarget.cells[0]?.targetHash, changedTarget.cells[1]?.targetHash);
});

test("report refuses conflicting parent/child snapshots and flags record target or harness-version drift", () => {
  const root = makeLabRoot();
  const s = spec(undefined, undefined, 2);
  const one = record(s, 1);
  one.target = target("agent", "unplanned-model");
  const two = record(s, 2);
  two.execution.harnessVersion = "claude-test 2.0";
  store(root, s, [one, two]);
  const report = buildBenchReport(root, [suite(root, [s])], { pricingFile: prices(root) });
  assert.equal(report.cells[0]?.snapshotMismatch, true);
  assert.equal(report.balanced[0]?.comparable, false);
  assert.ok(report.warnings.some((value) => value.includes("版本")));
  assert.equal(report.cells[0]?.attempts[0]?.estimates[0]?.reason, "snapshot-mismatch");
  assert.equal(report.cells[0]?.attempts[0]?.estimates[0]?.lower, null);
  const modified = structuredClone(s);
  modified.task.timeoutMs += 1;
  assert.throws(() => buildBenchReport(root, [suite(root, [modified])]), /快照不一致/u);
});

test("fractional, unsafe or contradictory usage is unknown; invalid cached counters produce only a cache interval", () => {
  const root = makeLabRoot();
  const s = spec(undefined, undefined, 4);
  const records = [record(s, 1), record(s, 2), record(s, 3), record(s, 4)];
  const first = records[0]?.execution.usage;
  const second = records[1]?.execution.usage;
  const third = records[2]?.execution.usage;
  const fourth = records[3]?.execution.usage;
  assert.ok(first && second && third && fourth);
  first.promptTokens = 100.5;
  second.totalTokens = Number.MAX_SAFE_INTEGER + 1;
  third.totalTokens = 900;
  fourth.promptCacheHitTokens = 101;
  store(root, s, records);
  const report = buildBenchReport(root, [s.id], { pricingFile: prices(root) });
  assert.equal(report.cells[0]?.metrics.usage.known, 1);
  assert.equal(report.cells[0]?.metrics.usage.cacheKnown, 0);
  assert.equal(report.cells[0]?.attempts[3]?.estimates[0]?.reason, "cache-unknown");
  assert.ok(report.warnings.some((value) => value.includes("用量计数无效")));
  assert.ok(report.warnings.some((value) => value.includes("缓存命中计数无效")));
});

test("price validation rejects missing evidence, duplicate models and invalid token rates", () => {
  const root = makeLabRoot();
  const file = path.join(root, "bad-pricing.json");
  writeJson(file, {});
  assert.throws(() => readBenchReportPrices(file), /价格文件/u);
  const source = prices(root);
  const value = readBenchReportPrices(source).snapshot;
  const first = value.models[0];
  assert.ok(first);
  value.models.push(first);
  writeJson(file, value);
  assert.throws(() => readBenchReportPrices(file), /重复价格/u);
  value.models.pop();
  const rate = first.scenarios.offPeak;
  assert.ok(rate);
  rate.inputPerMillion = -1;
  writeJson(file, value);
  assert.throws(() => readBenchReportPrices(file), /无效价格/u);
});

test("analysis markdown and CSV preserve unknown costs, conditions, native source, and explicit estimates", () => {
  const root = makeLabRoot();
  const first = spec(undefined, "repair", 3);
  const one = record(first, 1);
  const two = record(first, 2, false);
  two.execution.status = "timeout";
  two.execution.usage = null;
  two.grade.status = "not-run";
  store(root, first, [one, two]);
  const report = buildBenchReport(root, [first.id], { pricingFile: prices(root), scenario: "offPeak" });
  assertMatchesGolden("bench-analysis.md", renderBenchAnalysisMarkdown(report));
  assertMatchesGolden("bench-analysis.csv", renderBenchAnalysisCsv(report));
});
