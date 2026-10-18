import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../client.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { loadTask, resolveProjectPath, resolveTarget, validateBenchName } from "./config.ts";
import { executionSecrets, redactExecutionValue } from "./executor.ts";
import { targetApiKeyEnv } from "./backend.ts";
import { describeBenchmark, executeBenchmarkSample, finalizeBenchmark, prepareBenchmark } from "./runner.ts";
import { benchmarksDir, writeBenchJson } from "./store.ts";
import { snapshotFixture } from "./workspace.ts";
import type { BenchmarkDeps, PreparedBenchmark } from "./runner.ts";
import type { BenchSuiteDefinition, BenchSuiteInput, BenchSuiteJob, BenchSuiteOverrides, BenchSuiteResult, BenchSuiteSpec, BenchSuiteState } from "./suite-types.ts";
import type { BenchRunRecord, BenchSpec } from "./types.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 必须是 ≥ 1 的安全整数`);
  return value;
}
function named(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是名称字符串`);
  return validateBenchName(value);
}
function unique(values: string[], label: string): void {
  if (values.length === 0) throw new Error(`${label} 至少需要一项`);
  if (new Set(values).size !== values.length) throw new Error(`${label} 名称不能重复`);
}

export function listBenchSuites(root: string): string[] {
  if (!existsSync(path.join(root, "bench-suites"))) return [];
  return readdirSync(resolveProjectPath(root, "bench-suites")).filter((name) => name.endsWith(".json"))
    .map((name) => validateBenchName(name.slice(0, -5))).sort();
}

export function loadBenchSuiteDefinition(root: string, name: string): BenchSuiteDefinition {
  validateBenchName(name);
  const raw: unknown = JSON.parse(readFileSync(resolveProjectPath(root, `bench-suites/${name}.json`), "utf8"));
  if (!object(raw) || raw.name !== name) throw new Error(`bench-suites/${name}.json 的 name 必须与文件名一致`);
  if (!Array.isArray(raw.tasks) || !Array.isArray(raw.targets)) throw new Error("suite tasks/targets 必须是数组");
  const tasks = raw.tasks.map((value: unknown) => {
    if (typeof value === "string") return { name: named(value, "task") };
    if (!object(value)) throw new Error("suite task 必须是名称或 {name, timeoutMs?}");
    const task: { name: string; timeoutMs?: number } = { name: named(value.name, "task.name") };
    if (value.timeoutMs !== undefined) task.timeoutMs = positive(value.timeoutMs, "task.timeoutMs");
    return task;
  });
  const targets = raw.targets.map((value: unknown) => named(value, "target"));
  unique(tasks.map((task) => task.name), "suite tasks");
  unique(targets, "suite targets");
  const definition: BenchSuiteDefinition = { name, tasks, targets, repeat: positive(raw.repeat ?? 3, "repeat"), concurrency: positive(raw.concurrency ?? 3, "concurrency") };
  if (raw.timeoutMs !== undefined) definition.timeoutMs = positive(raw.timeoutMs, "suite.timeoutMs");
  return definition;
}

/** CLI overrides > suite-wide timeout > per-task timeout > task definition. */
export function loadBenchSuite(root: string, name: string, overrides: BenchSuiteOverrides = {}): BenchSuiteInput {
  const definition = loadBenchSuiteDefinition(root, name);
  const timeoutMs = overrides.timeoutMs ?? definition.timeoutMs;
  if (timeoutMs !== undefined) positive(timeoutMs, "timeoutMs");
  const input: BenchSuiteInput = {
    name,
    tasks: definition.tasks.map((entry) => {
      const task = loadTask(root, entry.name);
      return { ...task, timeoutMs: timeoutMs ?? entry.timeoutMs ?? task.timeoutMs };
    }),
    targets: definition.targets.map((target) => resolveTarget(root, target)),
    repeat: positive(overrides.repeat ?? definition.repeat, "repeat"),
    concurrency: positive(overrides.concurrency ?? definition.concurrency, "concurrency"),
  };
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
  return input;
}

export function suiteDir(root: string, id: string): string {
  if (!/^e_[a-f0-9]{10}$/u.test(id)) throw new Error(`无效 suite id：${id}`);
  return path.join(benchmarksDir(root), id);
}

/** Round-robin task dispatch with rotating targets; no target-major execution blocks. */
function schedule(input: BenchSuiteInput, ids: string[]): BenchSuiteJob[] {
  const jobs: BenchSuiteJob[] = [];
  for (let sample = 1; sample <= input.repeat; sample += 1) {
    for (let offset = 0; offset < input.targets.length; offset += 1) {
      for (const [index, task] of input.tasks.entries()) {
        const target = input.targets[(offset + index + sample - 1) % input.targets.length];
        const benchmarkId = ids[index];
        if (target === undefined || benchmarkId === undefined) throw new Error("suite 调度缺少 task/target");
        jobs.push({ order: jobs.length + 1, benchmarkId, task: task.name, target: target.name, sample });
      }
    }
  }
  return jobs;
}

/** Pure preflight: resolves every route and snapshots every fixture without keys, CLI processes or writes. */
export function describeBenchSuite(root: string, input: BenchSuiteInput): unknown {
  validateBenchName(input.name);
  positive(input.repeat, "repeat");
  positive(input.concurrency, "concurrency");
  if (input.timeoutMs !== undefined) positive(input.timeoutMs, "timeoutMs");
  unique(input.tasks.map((task) => validateBenchName(task.name)), "suite tasks");
  unique(input.targets.map((target) => validateBenchName(target.name)), "suite targets");
  const tasks = input.tasks.map((task) => describeBenchmark(root, { task, targets: input.targets, repeat: input.repeat, concurrency: input.concurrency }));
  const ids = input.tasks.map((_, index) => `b_${index.toString(16).padStart(10, "0")}`);
  return { schemaVersion: 1, kind: "suite", name: input.name, repeat: input.repeat, concurrency: input.concurrency,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), tasks, schedule: schedule(input, ids) };
}

export async function runBenchSuite(root: string, input: BenchSuiteInput, deps: BenchmarkDeps = {}): Promise<BenchSuiteResult> {
  // All schema, route, task compatibility and fixture checks precede any data creation.
  describeBenchSuite(root, input);
  const id = `e_${randomBytes(5).toString("hex")}`;
  const dir = suiteDir(root, id);
  const createdAt = new Date().toISOString();
  const secrets = [...new Set(input.targets.flatMap((target) => executionSecrets(targetApiKeyEnv(target))))];
  const state: BenchSuiteState = { schemaVersion: 1, id, status: "planned", total: input.tasks.length * input.targets.length * input.repeat, completed: 0 };
  const saveState = (): void => writeBenchJson(path.join(dir, "state.json"), state, secrets);
  const planned: BenchSpec[] = input.tasks.map((task) => ({ schemaVersion: 1, id: `b_${randomBytes(5).toString("hex")}`, createdAt,
    task, targets: input.targets, repeat: input.repeat, concurrency: input.concurrency, fixture: snapshotFixture(root, task) }));
  const spec = redactExecutionValue({ schemaVersion: 1, kind: "suite", id, createdAt, name: input.name, repeat: input.repeat, concurrency: input.concurrency,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }), benchmarks: planned,
    schedule: schedule(input, planned.map((entry) => entry.id)) }, secrets) as BenchSuiteSpec;
  mkdirSync(dir, { recursive: true });
  writeBenchJson(path.join(dir, "spec.json"), spec, secrets);
  saveState();
  try {
    // No execution starts until *all* source fixtures and trusted task checks have been frozen.
    const prepared = input.tasks.map((task, index) => {
      const child = planned[index];
      if (child === undefined) throw new Error("suite 缺少子实验计划");
      const entry = prepareBenchmark(root, { task, targets: input.targets, repeat: input.repeat, concurrency: input.concurrency }, { id: child.id, createdAt });
      if (entry.spec.fixture.hash !== child.fixture.hash) throw new Error(`冻结前 fixture 发生变化：${task.name}`);
      return entry;
    });
    const byId = new Map(prepared.map((entry) => [entry.spec.id, entry]));
    const records = new Map<string, BenchRunRecord[]>(prepared.map((entry) => [entry.spec.id, []]));
    const infrastructureErrors: string[] = [];
    state.status = "running";
    state.startedAt = new Date().toISOString();
    saveState();
    // One pool for the whole experiment, rather than one pool for every child benchmark.
    await mapWithConcurrency(spec.schedule, input.concurrency, async (job) => {
      const entry: PreparedBenchmark | undefined = byId.get(job.benchmarkId);
      const target = entry?.input.targets.find((candidate) => candidate.name === job.target);
      if (entry === undefined || target === undefined) throw new Error("suite 冻结计划与执行任务不一致");
      try {
        const record = await executeBenchmarkSample(entry, target, job.sample, { ...deps,
          ...(deps.onProgress === undefined ? {} : { onProgress: (message: string) => deps.onProgress?.(`${job.task} / ${message}`) }) });
        records.get(job.benchmarkId)?.push(record);
        state.completed += 1;
        saveState();
      } catch (error) {
        // Drain all in-flight processes before final state/report; never fabricate a sample record.
        infrastructureErrors.push(error instanceof Error ? error.message : String(error));
      }
    });
    const benchmarks = prepared.map((entry) => finalizeBenchmark(entry, records.get(entry.spec.id) ?? []));
    state.status = infrastructureErrors.length === 0 && state.completed === state.total ? "completed" : "interrupted";
    state.finishedAt = new Date().toISOString();
    if (infrastructureErrors.length > 0) state.error = redactSecrets(infrastructureErrors.join("\n"), secrets);
    saveState();
    return { spec, state, benchmarks, dir, failed: state.status !== "completed" || benchmarks.some((entry) => entry.failed) };
  } catch (error) {
    state.status = "interrupted";
    state.finishedAt = new Date().toISOString();
    state.error = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    saveState();
    throw new Error(state.error);
  }
}

function frozenSpec(value: unknown): value is BenchSpec {
  return object(value) && value.schemaVersion === 1 && typeof value.id === "string" && /^b_[a-f0-9]{10}$/u.test(value.id)
    && typeof value.createdAt === "string" && object(value.task) && typeof value.task.name === "string" && typeof value.task.prompt === "string"
    && Array.isArray(value.targets) && value.targets.every((target: unknown) => object(target) && typeof target.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(target.name))
    && typeof value.repeat === "number" && Number.isSafeInteger(value.repeat) && value.repeat > 0
    && typeof value.concurrency === "number" && Number.isSafeInteger(value.concurrency) && value.concurrency > 0
    && object(value.fixture) && typeof value.fixture.hash === "string" && Array.isArray(value.fixture.files);
}

export function readBenchSuite(root: string, id: string): { dir: string; spec: BenchSuiteSpec; state: BenchSuiteState } {
  const dir = suiteDir(root, id);
  const raw: unknown = JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8"));
  if (!object(raw) || raw.schemaVersion !== 1 || raw.kind !== "suite" || raw.id !== id || typeof raw.name !== "string" || typeof raw.createdAt !== "string"
      || !Array.isArray(raw.benchmarks) || raw.benchmarks.length === 0 || !raw.benchmarks.every(frozenSpec) || !Array.isArray(raw.schedule)) {
    throw new Error(`不支持或损坏的 suite：${id}`);
  }
  positive(raw.repeat, "suite repeat");
  positive(raw.concurrency, "suite concurrency");
  unique(raw.benchmarks.map((entry) => entry.id), "suite benchmarks");
  unique(raw.benchmarks.map((entry) => entry.task.name), "suite tasks");
  for (const entry of raw.benchmarks) {
    if (entry.repeat !== raw.repeat || entry.concurrency !== raw.concurrency) throw new Error(`suite 与子实验预算不一致：${id}`);
    unique(entry.targets.map((target) => target.name), "suite targets");
  }
  const children = new Map(raw.benchmarks.map((entry) => [entry.id, entry]));
  const expected = new Set(raw.benchmarks.flatMap((entry) => entry.targets.flatMap((target) => Array.from({ length: entry.repeat }, (_, index) => `${entry.id}:${target.name}:${String(index + 1)}`))));
  for (const [index, job] of raw.schedule.entries()) {
    if (!object(job) || job.order !== index + 1 || typeof job.benchmarkId !== "string" || typeof job.target !== "string" || typeof job.task !== "string" || typeof job.sample !== "number") {
      throw new Error(`损坏的 suite 调度：${id}`);
    }
    const child = children.get(job.benchmarkId);
    const key = `${job.benchmarkId}:${job.target}:${String(job.sample)}`;
    if (child?.task.name !== job.task || !expected.delete(key)) throw new Error(`损坏或重复的 suite 调度：${id}`);
  }
  if (expected.size !== 0) throw new Error(`不完整的 suite 调度：${id}`);
  const stateFile = path.join(dir, "state.json");
  const stateRaw: unknown = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
    schemaVersion: 1, id, status: "incomplete", total: raw.schedule.length, completed: 0,
  };
  if (!object(stateRaw) || stateRaw.schemaVersion !== 1 || stateRaw.id !== id || !["planned", "running", "completed", "interrupted", "incomplete"].includes(String(stateRaw.status))
      || stateRaw.total !== raw.schedule.length || typeof stateRaw.completed !== "number" || !Number.isSafeInteger(stateRaw.completed) || stateRaw.completed < 0 || stateRaw.completed > stateRaw.total) {
    throw new Error(`损坏的 suite 状态：${id}`);
  }
  return { dir, spec: raw as BenchSuiteSpec, state: stateRaw as BenchSuiteState };
}

export function listBenchSuiteRuns(root: string): { entries: Array<{ spec: BenchSuiteSpec; state: BenchSuiteState }>; warnings: string[] } {
  const base = benchmarksDir(root);
  if (!existsSync(base)) return { entries: [], warnings: [] };
  const entries: Array<{ spec: BenchSuiteSpec; state: BenchSuiteState }> = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("e_")) continue;
    try {
      const result = readBenchSuite(root, entry.name);
      entries.push({ spec: result.spec, state: result.state });
    } catch (error) { warnings.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`); }
  }
  entries.sort((a, b) => b.spec.createdAt.localeCompare(a.spec.createdAt));
  return { entries, warnings };
}
