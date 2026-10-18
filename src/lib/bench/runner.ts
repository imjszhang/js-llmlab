import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildChatRequest, redactSecrets } from "../client.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { executeTarget, executionSecrets, redactExecutionValue } from "./executor.ts";
import { targetApiKeyEnv } from "./backend.ts";
import { validateBenchName, validateTaskTarget } from "./config.ts";
import { gradeTask } from "./grader.ts";
import { planHarness } from "./harness.ts";
import { renderBenchReport } from "./render.ts";
import { benchmarkDir, sampleDir, writeBenchJson, writeBenchRecord } from "./store.ts";
import { diffSnapshots, materializeFixture, snapshotFixture, snapshotWorkspace } from "./workspace.ts";
import type { BenchRunRecord, BenchSpec, BenchTask, ExecutionResult, ExecutorDeps, ResolvedTarget } from "./types.ts";

export type BenchmarkInput = { task: BenchTask; targets: ResolvedTarget[]; repeat: number; concurrency: number };
export type BenchmarkResult = { spec: BenchSpec; records: BenchRunRecord[]; dir: string; failed: boolean };

export function describeBenchmark(root: string, input: BenchmarkInput): unknown {
  if (input.targets.length === 0) throw new Error("bench 至少需要一个 target");
  if (!Number.isSafeInteger(input.repeat) || input.repeat < 1) throw new Error("repeat 必须是 ≥ 1 的安全整数");
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) throw new Error("concurrency 必须是 ≥ 1 的安全整数");
  const names = input.targets.map((target) => validateBenchName(target.name));
  if (new Set(names).size !== names.length) throw new Error("target 名称不能重复");
  for (const target of input.targets) validateTaskTarget(input.task, target);
  const fixture = snapshotFixture(root, input.task);
  // Reject native project hooks before a suite can start any of its targets.
  // Empty directories are not materialized; runtime still checks the workspace.
  if (input.targets.some((target) => target.kind === "harness" && target.profile.adapter === "cursor-agent")
      && fixture.files.some((file) => file.path === ".cursor" || file.path.startsWith(".cursor/"))) {
    throw new Error("Cursor Agent fixture 不能包含 .cursor 目录或文件，以免加载项目 hooks/config");
  }
  return {
    schemaVersion: 1, task: input.task, fixture, repeat: input.repeat, concurrency: input.concurrency,
    targets: input.targets.map((target) => {
      if (target.kind === "llm") return { target, request: buildChatRequest(target.config,
        [...(target.systemText.trim() === "" ? [] : [{ role: "system" as const, content: target.systemText }]), { role: "user", content: input.task.prompt }], false) };
      const base = path.join(benchmarkDir(root, "b_0000000000"), "variants", target.name, "run-1");
      const plan = planHarness(target, { workspace: path.join(base, "workspace"), home: path.join(base, "home"), prompt: input.task.prompt, timeoutMs: input.task.timeoutMs });
      return { target, plan };
    }),
  };
}

function failedExecution(error: unknown): ExecutionResult {
  return { status: "failed", text: "", reasoning: null, usage: null, cost: null, sessionId: null,
    responseModel: null, events: [], error: error instanceof Error ? error.message : String(error),
    latencyMs: 0, exitCode: null, stdout: "", stderr: "", raw: null, harnessVersion: null, usageSource: null, costSource: null };
}

export type BenchmarkDeps = ExecutorDeps & { onProgress?: (message: string) => void };

/** A fully frozen task, ready for one or more independent samples. */
export type PreparedBenchmark = {
  root: string;
  input: BenchmarkInput;
  spec: BenchSpec;
  dir: string;
  secrets: string[];
};

/** Freeze before execution; suites prepare every task before dispatching their first sample. */
export function prepareBenchmark(root: string, input: BenchmarkInput, identity: { id?: string; createdAt?: string } = {}): PreparedBenchmark {
  describeBenchmark(root, input);
  const id = identity.id ?? `b_${randomBytes(5).toString("hex")}`;
  const dir = benchmarkDir(root, id);
  const secrets = [...new Set(input.targets.flatMap((target) => executionSecrets(targetApiKeyEnv(target))))];
  mkdirSync(dir, { recursive: true });
  const frozenDir = path.join(dir, "fixture");
  materializeFixture(root, input.task, frozenDir);
  const fixture = snapshotWorkspace(frozenDir);
  const spec = redactExecutionValue({ schemaVersion: 1, id, createdAt: identity.createdAt ?? new Date().toISOString(), ...input, fixture }, secrets) as BenchSpec;
  writeBenchJson(path.join(dir, "spec.json"), spec, secrets);
  return { root, input, spec, dir, secrets };
}

export async function executeBenchmarkSample(prepared: PreparedBenchmark, target: ResolvedTarget, sample: number, deps: BenchmarkDeps = {}): Promise<BenchRunRecord> {
  const { root, input, spec, dir, secrets } = prepared;
  const base = sampleDir(dir, target.name, sample);
  const workspace = path.join(base, "workspace");
  const home = path.join(base, "home");
  const record: BenchRunRecord = { schemaVersion: 1, target, task: input.task.name, sample, startedAt: new Date().toISOString(),
    workspace, home, execution: failedExecution("尚未开始"), grade: { status: "not-run", checks: [] }, changes: [] };
  const progress = (message: string): void => deps.onProgress?.(redactSecrets(message, secrets));
  progress(`${target.name} / ${String(sample)} 开始`);
  try {
    materializeFixture(dir, { ...input.task, fixture: "fixture" }, workspace);
    mkdirSync(home, { recursive: true });
    record.execution = await executeTarget({ root, target, task: input.task, workspace, home }, deps);
    // Attribute only the target's files to it. A checker may generate build/cache files.
    let snapshotError: string | null = null;
    try {
      record.changes = diffSnapshots(spec.fixture, snapshotWorkspace(workspace, spec.fixture));
    } catch (error) {
      snapshotError = `无法记录文件改动：${error instanceof Error ? error.message : String(error)}`;
    }
    record.grade = await gradeTask(input.task, record.execution, workspace, deps);
    if (snapshotError !== null) {
      record.grade = { status: "error", checks: [...record.grade.checks, { check: { kind: "file-exists", path: "." }, passed: false, detail: snapshotError }] };
    }
  } catch (error) {
    record.execution = failedExecution(error);
  }
  const clean = redactExecutionValue(record, secrets) as BenchRunRecord;
  writeBenchRecord(dir, clean, secrets);
  progress(`${target.name} / ${String(sample)}：${clean.execution.status} / ${clean.grade.status}`);
  return clean;
}

export function finalizeBenchmark(prepared: PreparedBenchmark, records: BenchRunRecord[]): BenchmarkResult {
  const { spec, dir, secrets } = prepared;
  // Keep the legacy report and return order stable even when a suite interleaves execution.
  const sorted = spec.targets.flatMap((target) => records.filter((record) => record.target.name === target.name).sort((a, b) => a.sample - b.sample));
  writeFileSync(path.join(dir, "report.md"), redactSecrets(renderBenchReport(spec, sorted), secrets), "utf8");
  return { spec, records: sorted, dir, failed: sorted.length !== spec.targets.length * spec.repeat
    || sorted.some((record) => record.execution.status !== "completed" || ["failed", "error"].includes(record.grade.status)) };
}

export async function runBenchmark(root: string, input: BenchmarkInput, deps: BenchmarkDeps = {}): Promise<BenchmarkResult> {
  const prepared = prepareBenchmark(root, input);
  // Preserve the original target-major dispatch order for existing single-task experiments.
  const jobs = input.targets.flatMap((target) => Array.from({ length: input.repeat }, (_, index) => ({ target, sample: index + 1 })));
  const records = await mapWithConcurrency(jobs, input.concurrency, ({ target, sample }) => executeBenchmarkSample(prepared, target, sample, deps));
  return finalizeBenchmark(prepared, records);
}
