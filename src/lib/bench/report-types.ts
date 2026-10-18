import type { BenchCost } from "./types.ts";

export type ReportRate = { inputPerMillion: number; cachedInputPerMillion?: number; outputPerMillion: number };
export type ReportPrices = {
  currency: string;
  verifiedAt: string;
  sources: Array<{ title: string; url: string }>;
  models: Array<{ provider: string; model: string; currency?: string; scenarios: Record<string, ReportRate> }>;
};
export type ReportRange = { mean: number; min: number; max: number; count: number };
export type ReportEstimate = {
  scenario: string;
  currency: string | null;
  lower: number | null;
  upper: number | null;
  reason: "exact" | "cache-unknown" | "usage-unknown" | "unpriced" | "snapshot-mismatch" | "subscription" | "native-service";
};
export type ReportAttempt = {
  benchmarkId: string;
  target: string;
  sample: number;
  execution: "completed" | "failed" | "timeout" | "missing";
  grade: "passed" | "failed" | "not-run" | "error" | "missing";
  passed: boolean;
  latencyMs: number | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; promptCacheHitTokens?: number } | null;
  usageSource: string | null;
  nativeCost: BenchCost | null;
  nativeCostSource: string | null;
  estimates: ReportEstimate[];
};
export type ReportMoney = {
  scenario: string;
  currency: string;
  /** Sum of known lower bounds only; null when no attempt is priced. */
  knownLowerBound: number | null;
  /** Null if any attempt is unpriced or lacks usage. */
  upperBound: number | null;
  total: number | null;
  knownAttempts: number;
  exactAttempts: number;
  plannedAttempts: number;
  meanPerAttempt: { lower: number; upper: number } | null;
  perSuccessfulDelivery: { lower: number; upper: number } | null;
};
export type ReportMetrics = {
  planned: number;
  recorded: number;
  execution: { completed: number; failed: number; timeout: number; missing: number };
  grade: { passed: number; failed: number; error: number; notRun: number; missing: number };
  passRate: number;
  allLatencyMs: ReportRange | null;
  passedLatencyMs: ReportRange | null;
  usage: { known: number; cacheKnown: number; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; cacheHitTokens: number | null; cacheHitRatio: number | null };
  estimatedCosts: ReportMoney[];
  nativeCosts: Array<{ source: string | null; currency: string; knownAttempts: number; knownTotal: number }>;
};
export type ReportCell = {
  cohort: string;
  benchmarkId: string;
  task: string;
  taskHash: string;
  fixtureHash: string;
  timeoutMs: number;
  repeat: number;
  concurrency: number;
  targetCount: number;
  target: string;
  targetHash: string;
  provider: string | null;
  /** Native account authentication is independent of an LLM API provider. Absent for legacy API records. */
  auth?: "chatgpt" | "claude-subscription" | "cursor-login" | "cursor-api-key";
  model: string;
  harness: string;
  harnessVersions: Array<string | null>;
  snapshotMismatch: boolean;
  metrics: ReportMetrics;
  attempts: ReportAttempt[];
};
export type ReportBalanced = {
  cohort: string;
  target: string;
  targetHash: string;
  provider: string | null;
  auth?: "chatgpt" | "claude-subscription" | "cursor-login" | "cursor-api-key";
  model: string;
  harness: string;
  taskCount: number;
  expectedTasks: number;
  comparable: boolean;
  /** Each task contributes equally, irrespective of its repeat count. */
  equalTaskPassRate: number | null;
  equalTaskMeanLatencyMs: number | null;
  equalTaskEstimatedCosts: Array<{ scenario: string; currency: string; meanPerAttempt: { lower: number; upper: number } | null }>;
  metrics: ReportMetrics;
};
export type BenchAnalysisReport = {
  schemaVersion: 1;
  kind: "bench-analysis";
  requestedIds: string[];
  benchmarkIds: string[];
  pricing: { sha256: string; snapshot: ReportPrices; scenarios: string[] } | null;
  cohorts: Array<{ id: string; kind: "benchmark" | "suite"; benchmarkIds: string[] }>;
  cells: ReportCell[];
  balanced: ReportBalanced[];
  warnings: string[];
};
