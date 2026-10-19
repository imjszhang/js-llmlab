import { readReportSupplement } from "./report-supplement.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "../paths.ts";
import { readBenchmark } from "./store.ts";
import type { BenchRunRecord, BenchSpec, ResolvedTarget } from "./types.ts";
import type { BenchAnalysisReport, ReportAttempt, ReportBalanced, ReportCell, ReportEstimate, ReportMetrics, ReportMoney, ReportPrices, ReportRange, ReportRate } from "./report-types.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Prices are user-maintained evidence, never inferred from model names or the clock. */
export function readBenchReportPrices(file: string): { snapshot: ReportPrices; sha256: string } {
  const source = readFileSync(file, "utf8");
  const raw: unknown = JSON.parse(source);
  if (!object(raw) || !text(raw.currency) || !text(raw.verifiedAt)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.verifiedAt) || !Array.isArray(raw.sources) || !raw.sources.length
    || !Array.isArray(raw.models) || !raw.models.length) throw new Error("价格文件需要 currency、verifiedAt、sources 和 models 数组");
  const verified = new Date(`${raw.verifiedAt}T00:00:00.000Z`);
  if (Number.isNaN(verified.getTime()) || verified.toISOString().slice(0, 10) !== raw.verifiedAt) throw new Error("verifiedAt 必须是有效的 YYYY-MM-DD 日期");
  const sources: ReportPrices["sources"] = [];
  for (const entry of raw.sources) {
    if (!object(entry) || !text(entry.title) || !text(entry.url)) throw new Error("价格来源需要 title 和 url");
    sources.push({ title: entry.title, url: entry.url });
  }
  const models: ReportPrices["models"] = [];
  const seen = new Set<string>();
  for (const entry of raw.models) {
    if (!object(entry) || !text(entry.provider) || !text(entry.model) || !object(entry.scenarios)
      || Object.keys(entry.scenarios).length === 0 || (entry.currency !== undefined && !text(entry.currency))) throw new Error("每个价格模型需要明确 provider、model 和 scenarios");
    const key = `${entry.provider}\0${entry.model}`;
    if (seen.has(key)) throw new Error(`重复价格模型：${entry.provider}/${entry.model}`);
    seen.add(key);
    const scenarios: Record<string, ReportRate> = {};
    for (const [name, rate] of Object.entries(entry.scenarios)) {
      if (!text(name) || !object(rate) || !nonnegative(rate.inputPerMillion) || !nonnegative(rate.outputPerMillion)
        || (rate.cachedInputPerMillion !== undefined && !nonnegative(rate.cachedInputPerMillion))) throw new Error(`无效价格情景：${name}`);
      Object.defineProperty(scenarios, name, { enumerable: true, configurable: true, writable: true,
        value: { inputPerMillion: rate.inputPerMillion, outputPerMillion: rate.outputPerMillion,
          ...(rate.cachedInputPerMillion === undefined ? {} : { cachedInputPerMillion: rate.cachedInputPerMillion }) } });
    }
    models.push({ provider: entry.provider, model: entry.model, scenarios,
      ...(entry.currency === undefined ? {} : { currency: entry.currency }) });
  }
  return { snapshot: { currency: raw.currency, verifiedAt: raw.verifiedAt, sources, models }, sha256: createHash("sha256").update(source).digest("hex") };
}

function identity(target: ResolvedTarget): Pick<ReportCell, "provider" | "model" | "harness" | "auth"> {
  if (target.kind === "llm") return { provider: target.config.provider ?? "default", model: target.config.model, harness: "llm" };
  if (target.backend.auth === "chatgpt" || target.backend.auth === "claude-subscription"
    || target.backend.auth === "cursor-login" || target.backend.auth === "cursor-api-key") return { provider: null, model: target.backend.model, harness: target.profile.adapter, auth: target.backend.auth };
  return { provider: target.backend.provider, model: target.backend.model, harness: target.profile.adapter };
}

function providerLabel(value: Pick<ReportCell, "provider" | "auth">): string {
  if (value.auth === "chatgpt") return "ChatGPT 订阅";
  if (value.auth === "claude-subscription") return "Claude 订阅";
  if (value.auth === "cursor-login") return "Cursor 账号";
  if (value.auth === "cursor-api-key") return "Cursor 用户 API key";
  return value.provider ?? "未知";
}

function targetHash(target: ResolvedTarget): string {
  // File labels are not the identity of an execution configuration. Pricing is reported separately.
  if (target.kind === "llm") {
    const { name: _name, pricing: _pricing, ...config } = target.config;
    return hash({ kind: target.kind, config, systemText: target.systemText, apiKeyEnv: target.apiKeyEnv });
  }
  const { name: _name, ...profile } = target.profile;
  return hash({ kind: target.kind, profile, backend: target.backend });
}

function range(values: number[]): ReportRange | null {
  if (!values.length) return null;
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, min: Math.min(...values), max: Math.max(...values), count: values.length };
}

function usage(record: BenchRunRecord | undefined): ReportAttempt["usage"] {
  const value = record?.execution.usage;
  if (!value || !tokenCount(value.promptTokens) || !tokenCount(value.completionTokens) || !tokenCount(value.totalTokens)
    || value.totalTokens !== value.promptTokens + value.completionTokens) return null;
  const hit = value.promptCacheHitTokens;
  return { promptTokens: value.promptTokens, completionTokens: value.completionTokens, totalTokens: value.totalTokens,
    ...(tokenCount(hit) && hit <= value.promptTokens ? { promptCacheHitTokens: hit } : {}) };
}

function estimate(value: ReportAttempt["usage"], provider: string | null, model: string, prices: ReportPrices, scenario: string): ReportEstimate {
  const definition = prices.models.find((item) => item.provider === provider && item.model === model);
  const rate = definition && Object.hasOwn(definition.scenarios, scenario) ? definition.scenarios[scenario] : undefined;
  const currency = definition ? definition.currency ?? prices.currency : null;
  if (!rate) return { scenario, currency, lower: null, upper: null, reason: "unpriced" };
  if (!value) return { scenario, currency, lower: null, upper: null, reason: "usage-unknown" };
  const { promptTokens: prompt, completionTokens: output, promptCacheHitTokens: hit } = value;
  const cached = rate.cachedInputPerMillion;
  const outputCost = output * rate.outputPerMillion / 1e6;
  if (cached === undefined || hit !== undefined) {
    const inputCost = cached === undefined ? prompt * rate.inputPerMillion / 1e6
      : ((prompt - (hit ?? 0)) * rate.inputPerMillion + (hit ?? 0) * cached) / 1e6;
    return { scenario, currency, lower: inputCost + outputCost, upper: inputCost + outputCost, reason: "exact" };
  }
  return { scenario, currency, lower: outputCost + prompt * Math.min(cached, rate.inputPerMillion) / 1e6,
    upper: outputCost + prompt * Math.max(cached, rate.inputPerMillion) / 1e6, reason: "cache-unknown" };
}

function summarize(attempts: ReportAttempt[], prices: ReportPrices | null, scenarios: string[]): ReportMetrics {
  const passed = attempts.filter((item) => item.passed).length;
  const withUsage = attempts.flatMap((item) => item.usage ? [item.usage] : []);
  const withCache = withUsage.filter((item) => item.promptCacheHitTokens !== undefined);
  const sum = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) : null;
  const promptCached = sum(withCache.map((item) => item.promptTokens));
  const hits = sum(withCache.map((item) => item.promptCacheHitTokens ?? 0));
  const costs: ReportMoney[] = [];
  for (const scenario of scenarios) {
    const currencies = new Set(attempts.flatMap((item) => item.estimates.filter((value) => value.scenario === scenario && value.currency !== null).map((value) => value.currency ?? "")));
    // Even completely unpriced data remains visibly unknown in the configured currency.
    if (!currencies.size && prices) currencies.add(prices.currency);
    for (const currency of currencies) {
      const estimates = attempts.map((item) => item.estimates.find((value) => value.scenario === scenario && value.currency === currency));
      const known = estimates.flatMap((item) => item?.lower === null || item?.lower === undefined ? [] : [item.lower]);
      const allKnown = known.length === attempts.length;
      const lower = sum(known);
      const upper = allKnown ? sum(estimates.flatMap((item) => item?.upper === null || item?.upper === undefined ? [] : [item.upper])) : null;
      const exactAttempts = estimates.filter((item) => item?.reason === "exact").length;
      costs.push({ scenario, currency, knownLowerBound: lower, upperBound: upper,
        total: allKnown && exactAttempts === attempts.length ? lower : null,
        knownAttempts: known.length, exactAttempts, plannedAttempts: attempts.length,
        meanPerAttempt: allKnown && lower !== null && upper !== null ? { lower: lower / attempts.length, upper: upper / attempts.length } : null,
        perSuccessfulDelivery: allKnown && passed > 0 && lower !== null && upper !== null ? { lower: lower / passed, upper: upper / passed } : null });
    }
  }
  const native = new Map<string, { source: string | null; currency: string; knownAttempts: number; knownTotal: number }>();
  for (const item of attempts) {
    if (!item.nativeCost || !nonnegative(item.nativeCost.total)) continue;
    const key = `${item.nativeCostSource ?? "unknown"}\0${item.nativeCost.currency}`;
    const current = native.get(key) ?? { source: item.nativeCostSource, currency: item.nativeCost.currency, knownAttempts: 0, knownTotal: 0 };
    current.knownAttempts += 1;
    current.knownTotal += item.nativeCost.total;
    native.set(key, current);
  }
  return {
    planned: attempts.length, recorded: attempts.filter((item) => item.execution !== "missing").length,
    execution: { completed: attempts.filter((item) => item.execution === "completed").length,
      failed: attempts.filter((item) => item.execution === "failed").length, timeout: attempts.filter((item) => item.execution === "timeout").length,
      missing: attempts.filter((item) => item.execution === "missing").length },
    grade: { passed, failed: attempts.filter((item) => item.grade === "failed").length,
      error: attempts.filter((item) => item.grade === "error").length, notRun: attempts.filter((item) => item.grade === "not-run").length,
      missing: attempts.filter((item) => item.grade === "missing").length },
    passRate: attempts.length ? passed / attempts.length : 0,
    allLatencyMs: range(attempts.flatMap((item) => item.latencyMs === null ? [] : [item.latencyMs])),
    passedLatencyMs: range(attempts.flatMap((item) => item.passed && item.latencyMs !== null ? [item.latencyMs] : [])),
    usage: { known: withUsage.length, cacheKnown: withCache.length, promptTokens: sum(withUsage.map((item) => item.promptTokens)),
      completionTokens: sum(withUsage.map((item) => item.completionTokens)), totalTokens: sum(withUsage.map((item) => item.totalTokens)),
      cacheHitTokens: hits, cacheHitRatio: promptCached !== null && promptCached > 0 && hits !== null ? hits / promptCached : null },
    estimatedCosts: costs, nativeCosts: [...native.values()],
  };
}

type FrozenBenchmark = { spec: BenchSpec; cohort: string; records: BenchRunRecord[] };

function frozenBenchmarks(root: string, ids: readonly string[]): { entries: FrozenBenchmark[]; cohorts: BenchAnalysisReport["cohorts"]; warnings: string[] } {
  const entries: FrozenBenchmark[] = [];
  const cohorts: BenchAnalysisReport["cohorts"] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  // Expand suites first: an explicitly repeated child must not be counted twice or removed from its suite.
  const unique = [...new Set(ids)];
  for (const id of [...unique.filter((value) => value.startsWith("e_")), ...unique.filter((value) => !value.startsWith("e_"))]) {
    if (/^b_[a-f0-9]{10}$/u.test(id)) {
      if (seen.has(id)) { warnings.push(`重复实验已去重：${id}`); continue; }
      const value = readBenchmark(root, id);
      entries.push({ spec: value.spec, records: value.records, cohort: id });
      cohorts.push({ id, kind: "benchmark", benchmarkIds: [id] });
      seen.add(id);
    } else if (/^e_[a-f0-9]{10}$/u.test(id)) {
      const file = path.join(getDataDir(root), "benchmarks", id, "spec.json");
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!object(raw) || raw.schemaVersion !== 1 || raw.kind !== "suite" || raw.id !== id || !Array.isArray(raw.benchmarks)) throw new Error(`不支持或损坏的实验套件：${id}`);
      const children: string[] = [];
      for (const child of raw.benchmarks) {
        if (!object(child) || child.schemaVersion !== 1 || typeof child.id !== "string" || !/^b_[a-f0-9]{10}$/u.test(child.id)
          || !object(child.task) || !text(child.task.name) || !text(child.task.prompt) || !Array.isArray(child.targets)
          || !Number.isSafeInteger(child.repeat) || Number(child.repeat) < 1 || !object(child.fixture) || !text(child.fixture.hash)) throw new Error(`损坏的套件子实验：${id}`);
        if (seen.has(child.id)) { warnings.push(`重复实验已去重：${child.id}（属于 ${id}）`); continue; }
        let records: BenchRunRecord[] = [];
        try {
          const value = readBenchmark(root, child.id);
          if (hash(value.spec) !== hash(child)) throw new Error(`套件与子实验快照不一致：${child.id}`);
          records = value.records;
        } catch (error) {
          if (!object(error) || error.code !== "ENOENT") throw error;
          warnings.push(`子实验尚未落盘，按计划样本统计缺失：${child.id}`);
        }
        entries.push({ spec: child as BenchSpec, records, cohort: id });
        children.push(child.id);
        seen.add(child.id);
      }
      cohorts.push({ id, kind: "suite", benchmarkIds: children });
    } else throw new Error(`无效 benchmark / suite id：${id}`);
  }
  if (unique.length !== ids.length) warnings.push("重复输入 id 已去重");
  if (cohorts.length > 1) warnings.push("不同实验轮次分别展示；裸 benchmark 不自动合并为同一排名。需要任务等权对比时使用同一实验套件。");
  return { entries, cohorts, warnings };
}

/** Offline analysis reads only frozen spec/record files; original records and reports remain untouched. */
export function buildBenchReport(root: string, ids: readonly string[], options: { pricingFile?: string; scenario?: string; reviewFile?: string } = {}): BenchAnalysisReport {
  if (!ids.length) throw new Error("至少指定一个 benchmark 或 suite id");
  if (options.scenario && !options.pricingFile) throw new Error("--scenario 需要 --pricing");
  const prices = options.pricingFile ? readBenchReportPrices(options.pricingFile) : null;
  const scenarios = prices ? [...new Set(prices.snapshot.models.flatMap((item) => Object.keys(item.scenarios)))] : [];
  if (options.scenario && !scenarios.includes(options.scenario)) throw new Error(`价格文件没有情景：${options.scenario}`);
  const selectedScenarios = options.scenario ? [options.scenario] : scenarios;
  const loaded = frozenBenchmarks(root, ids);
  const supplement = options.reviewFile ? readReportSupplement(root, options.reviewFile, loaded.entries.map((item) => item.spec.id)) : undefined;
  const warnings = [...loaded.warnings];
  const cells: ReportCell[] = [];
  for (const { spec, records, cohort } of loaded.entries) {
    for (const target of spec.targets) {
      const info = identity(target);
      const nativeAccount = info.auth !== undefined;
      const cursorService = info.auth === "cursor-login" || info.auth === "cursor-api-key";
      const attempts: ReportAttempt[] = [];
      const targetRecords = records.filter((item) => item.target.name === target.name);
      const versions = [...new Set(targetRecords.map((item) => item.execution.harnessVersion ?? null))];
      const mismatch = targetRecords.some((item) => targetHash(item.target) !== targetHash(target));
      if (mismatch) warnings.push(`${spec.id}/${target.name} 的 record target 与冻结 spec 不一致，禁止作为可比汇总`);
      if (versions.length > 1) warnings.push(`${spec.id}/${target.name} 包含不同 harness 版本，禁止作为可比汇总`);
      for (let sample = 1; sample <= spec.repeat; sample += 1) {
        const record = targetRecords.find((item) => item.sample === sample);
        const review = supplement?.snapshot.entries.find((entry) => entry.benchmarkId === spec.id && entry.target === target.name && entry.sample === sample);
        const value = cursorService ? null : usage(record);
        const sampleMismatch = record !== undefined && targetHash(record.target) !== targetHash(target);
        if (cursorService && record?.execution.usage) warnings.push(`${spec.id}/${target.name}/${String(sample)} 的 Cursor 完整 token 用量尚未验证，忽略记录中的用量数字`);
        if (!cursorService && record?.execution.usage && !value) warnings.push(`${spec.id}/${target.name}/${String(sample)} 用量计数无效或总数不等于输入加输出，费用未知`);
        if (!cursorService && record?.execution.usage?.promptCacheHitTokens !== undefined && value?.promptCacheHitTokens === undefined) warnings.push(`${spec.id}/${target.name}/${String(sample)} 缓存命中计数无效，按未知缓存比例估价`);
        if (record && record.execution.status !== "completed" && record.grade.status === "passed") warnings.push(`${spec.id}/${target.name}/${String(sample)} 执行未完成却标为验收通过，不计入成功交付`);
        if (nativeAccount && record?.execution.cost !== null && record?.execution.cost !== undefined) warnings.push(`${spec.id}/${target.name}/${String(sample)} 使用 ${providerLabel(info)}，忽略记录中的原生金额；单次实际费用未知`);
        attempts.push({ benchmarkId: spec.id, target: target.name, sample, execution: record?.execution.status ?? "missing",
          grade: record?.grade.status ?? "missing", passed: record?.execution.status === "completed" && record.grade.status === "passed",
          latencyMs: record && nonnegative(record.execution.latencyMs) ? record.execution.latencyMs : null, usage: value,
          usageSource: cursorService ? null : record?.execution.usageSource ?? null,
          nativeCost: nativeAccount ? null : record?.execution.cost ?? null,
          nativeCostSource: nativeAccount ? null : record?.execution.costSource ?? null,
          ...(review ? { review, reviewedUsage: review.usageAlternatives.map((alternative) => ({ usage: alternative,
            estimates: prices ? selectedScenarios.map((scenario): ReportEstimate => nativeAccount
              ? { scenario, currency: null, lower: null, upper: null, reason: cursorService ? "native-service" : "subscription" }
              : sampleMismatch ? { scenario, currency: null, lower: null, upper: null, reason: "snapshot-mismatch" }
                : estimate(alternative, info.provider, info.model, prices.snapshot, scenario)) : [] })) } : {}),
          estimates: prices ? selectedScenarios.map((scenario) => {
            if (cursorService) return { scenario, currency: null, lower: null, upper: null, reason: "native-service" };
            if (nativeAccount) return { scenario, currency: null, lower: null, upper: null, reason: "subscription" };
            const result = estimate(value, info.provider, info.model, prices.snapshot, scenario);
            return sampleMismatch ? { ...result, lower: null, upper: null, reason: "snapshot-mismatch" } : result;
          }) : [] });
      }
      cells.push({ cohort, benchmarkId: spec.id, task: spec.task.name, taskHash: hash(spec.task), fixtureHash: spec.fixture.hash,
        timeoutMs: spec.task.timeoutMs, repeat: spec.repeat, concurrency: spec.concurrency, targetCount: spec.targets.length,
        target: target.name, targetHash: targetHash(target), ...info, harnessVersions: versions, snapshotMismatch: mismatch,
        ...(target.kind === "harness" && target.profile.execution ? { executionPolicy: target.profile.execution } : {}),
        metrics: summarize(attempts, prices?.snapshot ?? null, selectedScenarios), attempts });
    }
  }
  const balanced: ReportBalanced[] = [];
  for (const cohort of loaded.cohorts.filter((item) => item.kind === "suite")) {
    const inCohort = cells.filter((item) => item.cohort === cohort.id);
    const taskDefinitions = new Set(inCohort.map((item) => `${item.task}\0${item.taskHash}\0${item.fixtureHash}`));
    const names = new Map<string, Set<string>>();
    for (const item of inCohort) {
      const values = names.get(item.task) ?? new Set<string>();
      values.add(`${item.taskHash}\0${item.fixtureHash}`);
      names.set(item.task, values);
    }
    const taskConflict = [...names.values()].some((values) => values.size > 1);
    if (taskConflict) warnings.push(`${cohort.id} 同名任务包含不同题面、验收、fixture 或预算，禁止合成可比排名`);
    const targets = new Map<string, ReportCell[]>();
    for (const item of inCohort) {
      const group = `${item.target}\0${item.targetHash}`;
      const values = targets.get(group) ?? [];
      values.push(item);
      targets.set(group, values);
    }
    for (const group of targets.values()) {
      const first = group[0];
      if (!first) continue;
      const definitions = new Set(group.map((item) => `${item.task}\0${item.taskHash}\0${item.fixtureHash}`));
      const harnessVersions = new Set(group.flatMap((item) => item.harnessVersions));
      const targetConflict = inCohort.some((item) => item.target === first.target && item.targetHash !== first.targetHash);
      const workloads = new Set(group.map((item) => `${String(item.concurrency)}\0${String(item.targetCount)}`));
      const comparable = !taskConflict && !targetConflict && !group.some((item) => item.snapshotMismatch) && harnessVersions.size <= 1
        && workloads.size <= 1 && definitions.size === taskDefinitions.size && definitions.size === group.length;
      if (targetConflict) warnings.push(`${cohort.id}/${first.target} 的实际配置不同，分别展示并禁止合成排名`);
      if (harnessVersions.size > 1) warnings.push(`${cohort.id}/${first.target} 的 harness 版本不同，禁止合成排名`);
      if (workloads.size > 1) warnings.push(`${cohort.id}/${first.target} 的并发或同时运行 targets 数不同，禁止合成排名`);
      const equalCosts: ReportBalanced["equalTaskEstimatedCosts"] = [];
      const costKeys = new Set(group.flatMap((item) => item.metrics.estimatedCosts.map((cost) => `${cost.scenario}\0${cost.currency}`)));
      for (const key of costKeys) {
        const [scenario = "", currency = ""] = key.split("\0");
        const means = group.map((item) => item.metrics.estimatedCosts.find((cost) => cost.scenario === scenario && cost.currency === currency)?.meanPerAttempt ?? null);
        equalCosts.push({ scenario, currency, meanPerAttempt: comparable && means.every((value) => value !== null)
          ? { lower: means.reduce((sum, value) => sum + (value?.lower ?? 0), 0) / group.length,
            upper: means.reduce((sum, value) => sum + (value?.upper ?? 0), 0) / group.length } : null });
      }
      balanced.push({ cohort: cohort.id, target: first.target, targetHash: first.targetHash, provider: first.provider, model: first.model,
        ...(first.auth === undefined ? {} : { auth: first.auth }),
        harness: first.harness, taskCount: definitions.size, expectedTasks: taskDefinitions.size, comparable,
        equalTaskPassRate: comparable ? group.reduce((sum, item) => sum + item.metrics.passRate, 0) / group.length : null,
        equalTaskMeanLatencyMs: comparable && group.every((item) => item.metrics.allLatencyMs !== null)
          ? group.reduce((sum, item) => sum + (item.metrics.allLatencyMs?.mean ?? 0), 0) / group.length : null,
        equalTaskEstimatedCosts: equalCosts,
        metrics: summarize(group.flatMap((item) => item.attempts), prices?.snapshot ?? null, selectedScenarios) });
    }
  }
  return { schemaVersion: 1, kind: "bench-analysis", ...(supplement ? { supplement } : {}), requestedIds: [...new Set(ids)], benchmarkIds: loaded.entries.map((item) => item.spec.id),
    pricing: prices ? { ...prices, scenarios: selectedScenarios } : null, cohorts: loaded.cohorts, cells, balanced, warnings: [...new Set(warnings)] };
}

function cell(value: string): string { return value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " "); }
function seconds(value: ReportRange | null): string { return value ? `${(value.mean / 1000).toFixed(2)} (${(value.min / 1000).toFixed(2)}–${(value.max / 1000).toFixed(2)})` : "-"; }
function moneyRange(value: { lower: number; upper: number } | null): string {
  return !value ? "未知" : value.lower === value.upper ? value.lower.toFixed(6) : `${value.lower.toFixed(6)}–${value.upper.toFixed(6)}`;
}

export function renderBenchAnalysisMarkdown(report: BenchAnalysisReport): string {
  const lines = ["# Benchmark 离线分析", "", `输入：${report.requestedIds.join(", ")}；去重后 ${String(report.benchmarkIds.length)} 个子实验。`, "",
    "通过率分母包含全部计划样本；未落盘样本单独标为缺失。耗时含失败与超时，成功耗时只含执行完成且验收通过的样本。", "",
    "## 逐任务结果", "", "| 轮次 | 任务 / target | provider / 模型 | 通过 / 计划 | 执行：完成/失败/超时/缺失 | 验收：失败/错误/未运行/缺失 | 全部耗时 s 均值 (范围) | 成功耗时 s 均值 (范围) | 用量覆盖 |",
    "| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: |"];
  for (const item of report.cells) {
    const m = item.metrics;
    lines.push(`| ${cell(item.cohort)} / ${cell(item.benchmarkId)} | ${cell(item.task)} / ${cell(item.target)} | ${cell(providerLabel(item))} / ${cell(item.model)} | ${String(m.grade.passed)}/${String(m.planned)} | ${String(m.execution.completed)}/${String(m.execution.failed)}/${String(m.execution.timeout)}/${String(m.execution.missing)} | ${String(m.grade.failed)}/${String(m.grade.error)}/${String(m.grade.notRun)}/${String(m.grade.missing)} | ${seconds(m.allLatencyMs)} | ${seconds(m.passedLatencyMs)} | ${String(m.usage.known)}/${String(m.planned)} |`);
  }
  lines.push("", "## 条件与快照", "", "| 实验 / target | Harness / 版本 | 预算 ms | repeat / 并发 / targets | 任务 SHA-256 | fixture SHA-256 | target SHA-256 |", "| --- | --- | ---: | --- | --- | --- | --- |");
  for (const item of report.cells) lines.push(`| ${cell(item.benchmarkId)} / ${cell(item.target)} | ${cell(item.harness)} / ${cell(item.harnessVersions.map((value) => value ?? "未知").join(", ") || "未知")} | ${String(item.timeoutMs)} | ${String(item.repeat)} / ${String(item.concurrency)} / ${String(item.targetCount)} | ${item.taskHash} | ${item.fixtureHash} | ${item.targetHash} |`);
  if (report.cells.some((item) => item.executionPolicy)) {
    lines.push("", "## 显式执行策略", "", "| 实验 / target | 完整权限 | 代理策略 | 输出上限 bytes | 锁定模型别名 |", "| --- | --- | --- | ---: | --- |");
    for (const item of report.cells) if (item.executionPolicy) {
      const p = item.executionPolicy;
      lines.push(`| ${cell(item.benchmarkId)} / ${cell(item.target)} | ${p.fullAccess ? "是" : "否"} | ${cell(p.proxy ?? "继承默认")} | ${p.maxOutputBytes ?? "默认 16777216"} | ${p.pinModelAliases ? "是" : "否"} |`);
    }
  }
  if (report.balanced.length) {
    lines.push("", "## 套件任务等权汇总", "", "| 套件 / target | 任务覆盖 | 可比条件 | 等权通过率 | 等权平均耗时 s | 通过 / 计划 |", "| --- | ---: | --- | ---: | ---: | ---: |");
    for (const item of report.balanced) lines.push(`| ${cell(item.cohort)} / ${cell(item.target)} | ${String(item.taskCount)}/${String(item.expectedTasks)} | ${item.comparable ? "一致" : "有差异，不作排名"} | ${item.equalTaskPassRate === null ? "-" : `${(item.equalTaskPassRate * 100).toFixed(1)}%`} | ${item.equalTaskMeanLatencyMs === null ? "-" : (item.equalTaskMeanLatencyMs / 1000).toFixed(2)} | ${String(item.metrics.grade.passed)}/${String(item.metrics.planned)} |`);
  }
  lines.push("", "## 费用估算", "");
  if (report.cells.some((item) => item.auth === "chatgpt")) lines.push("ChatGPT 订阅按订阅额度使用；单次实际费用未知，不套用 API token 价格，也不将原生零金额解释为免费。token 和耗时照常统计。", "");
  if (report.cells.some((item) => item.auth === "claude-subscription")) lines.push("Claude 订阅按订阅额度使用；单次实际费用未知，不套用 API token 价格，也不将原生 total_cost_usd 解释为实际账单。token 和耗时照常统计。", "");
  if (report.cells.some((item) => item.auth === "cursor-login" || item.auth === "cursor-api-key")) lines.push("Cursor 账号与 Cursor 用户 API key 均使用 Cursor 原生服务；单次实际费用未知，不套用 LLM provider 的 API token 价格，也不将原生零金额解释为免费。当前 adapter 无法验证完整 token 用量，用量及其来源保持未知；耗时照常统计。", "");
  if (report.pricing) {
    lines.push(`价格核对日期：${cell(report.pricing.snapshot.verifiedAt)}；价格文件 SHA-256：${report.pricing.sha256}。`, "");
    for (const source of report.pricing.snapshot.sources) lines.push(`- [${cell(source.title)}](${source.url})`);
    lines.push("", "按明确 provider + model 匹配价格；情景由用户选择，不自动判断峰谷。输出已含推理 token，不重复相加。缓存命中未知时提供上下界；缺用量不按零计算。费用包含失败尝试；每成功交付费用仅在全部尝试可估价且至少一次通过时计算。", "",
      "| 实验 / target | 情景 / 币种 | 估价覆盖 | 已知费用下限 | 总费用 | 每次尝试 | 每成功交付 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const item of report.cells) for (const cost of item.metrics.estimatedCosts) lines.push(`| ${cell(item.benchmarkId)} / ${cell(item.target)} | ${cell(cost.scenario)} / ${cell(cost.currency)} | ${String(cost.knownAttempts)}/${String(cost.plannedAttempts)} | ${cost.knownLowerBound === null ? "未知" : cost.knownLowerBound.toFixed(6)} | ${cost.upperBound === null || cost.knownLowerBound === null ? "未知" : moneyRange({ lower: cost.knownLowerBound, upper: cost.upperBound })} | ${moneyRange(cost.meanPerAttempt)} | ${moneyRange(cost.perSuccessfulDelivery)} |`);
    if (report.balanced.length) {
      lines.push("", "| 套件 / target | 情景 / 币种 | 任务等权平均每次费用 | 全部尝试 / 成功交付费用 |", "| --- | --- | ---: | ---: |");
      for (const item of report.balanced) for (const cost of item.equalTaskEstimatedCosts) {
        const combined = item.metrics.estimatedCosts.find((value) => value.scenario === cost.scenario && value.currency === cost.currency);
        lines.push(`| ${cell(item.cohort)} / ${cell(item.target)} | ${cell(cost.scenario)} / ${cell(cost.currency)} | ${moneyRange(cost.meanPerAttempt)} | ${moneyRange(combined?.perSuccessfulDelivery ?? null)} |`);
      }
    }
  } else lines.push("未指定价格文件，不重算 API 费用。用 --pricing 指定用户维护的价格快照；原生费用单独列出。", "");
  const native = report.cells.filter((item) => item.metrics.nativeCosts.length);
  if (native.length) {
    lines.push("", "## 原生费用记录（未用于 API 估算）", "", "Harness 原生费用可能使用其他模型定价；不同来源、币种分别保留，不视为 provider 账单。", "", "| 实验 / target | 来源 / 币种 | 有值样本 | 已知金额 |", "| --- | --- | ---: | ---: |");
    for (const item of native) for (const cost of item.metrics.nativeCosts) lines.push(`| ${cell(item.benchmarkId)} / ${cell(item.target)} | ${cell(cost.source ?? "未知")} / ${cell(cost.currency)} | ${String(cost.knownAttempts)}/${String(item.metrics.planned)} | ${cost.knownTotal.toFixed(6)} |`);
  }
  if (report.supplement) {
    lines.push("", "## 人工评审与用量核对", "", `附件 SHA-256：${report.supplement.sha256}。评审不改变自动验收；核对用量单独估算，不覆盖原始用量或混入汇总费用。证据路径仅作引用，不执行或自动读取。`, "");
    for (const item of report.cells) for (const attempt of item.attempts) {
      const review = attempt.review;
      if (!review) continue;
      lines.push(`### ${cell(attempt.benchmarkId)} / ${cell(attempt.target)} / ${attempt.sample}`, "",
        `评审：${cell(review.verdict)}；${cell(review.reviewer || "未填写")} / ${review.method} / ${cell(review.reviewedAt || "未填写")}。`, "", cell(review.notes), "");
      for (const score of review.scores) lines.push(`- ${cell(score.dimension)}：${score.score}/${score.max}`);
      for (const evidence of review.evidence) lines.push(`- 证据：${cell(evidence)}`);
      for (const alternative of attempt.reviewedUsage ?? []) {
        const u = alternative.usage;
        lines.push("", `核对口径 ${cell(u.label)}（${cell(u.source)}）：输入 ${u.promptTokens}，输出 ${u.completionTokens}，缓存命中 ${u.promptCacheHitTokens ?? "未知"}。`, "");
        for (const estimate of alternative.estimates) lines.push(`- ${cell(estimate.scenario)} / ${cell(estimate.currency ?? "未知")}：${estimate.lower === null || estimate.upper === null ? "未知" : moneyRange({ lower: estimate.lower, upper: estimate.upper })}（${estimate.reason}）`);
      }
      lines.push("");
    }
  }
  if (report.supplement) while (lines.at(-1) === "") lines.pop();
  if (report.warnings.length) lines.push("", "## 提示", "", ...report.warnings.map((warning) => `- ${cell(warning)}`));
  return `${lines.join("\n")}\n`;
}

function csv(value: string | number | null): string {
  const result = value === null ? "" : String(value);
  return /[",\r\n]/u.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}

/** One row per task/target/scenario/currency; blank numeric fields mean unknown, never zero. */
export function renderBenchAnalysisCsv(report: BenchAnalysisReport): string {
  const hasNativeAuth = report.cells.some((item) => item.auth !== undefined);
  const rows: Array<Array<string | number | null>> = [["cohort", "benchmark", "task", "target", "provider", "model", "harness", "versions", "taskHash", "fixtureHash", "targetHash", "timeoutMs", "repeat", "concurrency", "targetCount", "planned", "recorded", "passed", "executionFailed", "timeouts", "missing", "gradeFailed", "gradeError", "gradeNotRun", "allMeanMs", "allMinMs", "allMaxMs", "passedMeanMs", "usageKnown", "cacheKnown", "promptTokens", "completionTokens", "totalTokens", "cacheHitTokens", "scenario", "currency", "pricedAttempts", "knownCostLowerBound", "totalCost", "costUpperBound", "meanCostLower", "meanCostUpper", "perSuccessLower", "perSuccessUpper"]];
  for (const item of report.cells) {
    const m = item.metrics;
    const costs: Array<ReportMoney | null> = m.estimatedCosts.length ? m.estimatedCosts : [null];
    for (const cost of costs) rows.push([item.cohort, item.benchmarkId, item.task, item.target, item.provider, item.model, item.harness,
      item.harnessVersions.map((value) => value ?? "unknown").join(";"), item.taskHash, item.fixtureHash, item.targetHash,
      item.timeoutMs, item.repeat, item.concurrency, item.targetCount, m.planned, m.recorded, m.grade.passed, m.execution.failed, m.execution.timeout, m.execution.missing,
      m.grade.failed, m.grade.error, m.grade.notRun, m.allLatencyMs?.mean ?? null, m.allLatencyMs?.min ?? null, m.allLatencyMs?.max ?? null,
      m.passedLatencyMs?.mean ?? null, m.usage.known, m.usage.cacheKnown, m.usage.promptTokens, m.usage.completionTokens, m.usage.totalTokens, m.usage.cacheHitTokens,
      cost?.scenario ?? null, cost?.currency ?? null, cost?.knownAttempts ?? null, cost?.knownLowerBound ?? null, cost?.total ?? null, cost?.upperBound ?? null,
      cost?.meanPerAttempt?.lower ?? null, cost?.meanPerAttempt?.upper ?? null, cost?.perSuccessfulDelivery?.lower ?? null, cost?.perSuccessfulDelivery?.upper ?? null,
      ...(hasNativeAuth ? [item.auth ?? "api-key"] : [])]);
  }
  if (hasNativeAuth) rows[0]?.push("auth");
  if (report.cells.some((item) => item.executionPolicy)) {
    rows[0]?.push("executionPolicyJson");
    let index = 1;
    for (const item of report.cells) for (let i = 0; i < Math.max(1, item.metrics.estimatedCosts.length); i += 1) rows[index++]?.push(item.executionPolicy ? JSON.stringify(item.executionPolicy) : null);
  }
  if (report.supplement) {
    rows[0]?.push("reviewsJson", "reviewedUsageJson");
    let index = 1;
    for (const item of report.cells) {
      for (let i = 0; i < Math.max(1, item.metrics.estimatedCosts.length); i += 1) rows[index++]?.push(
        JSON.stringify(item.attempts.flatMap((a) => a.review ? [a.review] : [])),
        JSON.stringify(item.attempts.flatMap((a) => a.reviewedUsage ? [{ sample: a.sample, alternatives: a.reviewedUsage }] : [])));
    }
  }
  return `${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`;
}
