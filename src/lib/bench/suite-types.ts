import type { BenchmarkResult } from "./runner.ts";
import type { BenchSpec, BenchTask, ResolvedTarget } from "./types.ts";

export type BenchSuiteDefinition = {
  name: string;
  tasks: Array<{ name: string; timeoutMs?: number }>;
  targets: string[];
  repeat: number;
  concurrency: number;
  timeoutMs?: number;
};
export type BenchSuiteOverrides = { repeat?: number; concurrency?: number; timeoutMs?: number };
export type BenchSuiteInput = {
  name: string;
  tasks: BenchTask[];
  targets: ResolvedTarget[];
  repeat: number;
  concurrency: number;
  timeoutMs?: number;
};
export type BenchSuiteJob = { order: number; benchmarkId: string; task: string; target: string; sample: number };
export type BenchSuiteSpec = {
  schemaVersion: 1;
  kind: "suite";
  id: string;
  createdAt: string;
  name: string;
  repeat: number;
  concurrency: number;
  timeoutMs?: number;
  /** Complete frozen child specs. Child records remain in their existing b_* directories. */
  benchmarks: BenchSpec[];
  /** Deterministic dispatch order, independent of actual finish order. */
  schedule: BenchSuiteJob[];
};
export type BenchSuiteState = {
  schemaVersion: 1;
  id: string;
  status: "planned" | "running" | "completed" | "interrupted" | "incomplete";
  total: number;
  completed: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};
export type BenchSuiteResult = {
  spec: BenchSuiteSpec;
  state: BenchSuiteState;
  benchmarks: BenchmarkResult[];
  dir: string;
  failed: boolean;
};
