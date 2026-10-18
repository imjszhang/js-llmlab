import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../client.ts";
import { redactExecutionValue } from "./executor.ts";
import { getDataDir } from "../paths.ts";
import type { BenchRunRecord, BenchSpec } from "./types.ts";

export function benchmarksDir(root: string): string {
  return path.join(getDataDir(root), "benchmarks");
}

export function benchmarkDir(root: string, id: string): string {
  if (!/^b_[a-f0-9]{10}$/u.test(id)) throw new Error(`无效 benchmark id：${id}`);
  return path.join(benchmarksDir(root), id);
}

export function sampleDir(dir: string, target: string, sample: number): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(target) || !Number.isSafeInteger(sample) || sample < 1) {
    throw new Error("无效 target 或采样编号");
  }
  return path.join(dir, "variants", target, `run-${String(sample)}`);
}

export function writeBenchJson(file: string, value: unknown, secrets: readonly string[] = []): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(redactExecutionValue(value, secrets), null, 2)}\n`, "utf8");
}

export function writeBenchRecord(dir: string, record: BenchRunRecord, secrets: readonly string[]): void {
  const destination = sampleDir(dir, record.target.name, record.sample);
  writeBenchJson(path.join(destination, "record.json"), record, secrets);
  writeBenchJson(path.join(destination, "changes.json"), record.changes, secrets);
  const outputs = {
    "output.md": record.execution.text,
    "stdout.log": record.execution.stdout,
    "stderr.log": record.execution.stderr,
    "events.jsonl": record.execution.events.map((event) => JSON.stringify(event)).join("\n"),
  };
  for (const [name, content] of Object.entries(outputs)) {
    writeFileSync(path.join(destination, name), redactSecrets(content, secrets), "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBenchmark(root: string, id: string): { dir: string; spec: BenchSpec; records: BenchRunRecord[] } {
  const dir = benchmarkDir(root, id);
  const raw: unknown = JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.id !== id || !Array.isArray(raw.targets)
    || typeof raw.repeat !== "number" || !Number.isSafeInteger(raw.repeat) || raw.repeat < 1
    || typeof raw.createdAt !== "string" || !isRecord(raw.task) || typeof raw.task.name !== "string"
    || typeof raw.task.prompt !== "string" || !isRecord(raw.fixture) || typeof raw.fixture.hash !== "string"
    || !Array.isArray(raw.fixture.files) || typeof raw.concurrency !== "number" || !Number.isSafeInteger(raw.concurrency) || raw.concurrency < 1) {
    throw new Error(`不支持或损坏的 benchmark：${id}`);
  }
  const spec = raw as BenchSpec;
  const records: BenchRunRecord[] = [];
  for (const target of spec.targets) {
    if (!isRecord(target) || typeof target.name !== "string") throw new Error(`损坏的 benchmark target：${id}`);
    for (let sample = 1; sample <= spec.repeat; sample += 1) {
      const file = path.join(sampleDir(dir, target.name, sample), "record.json");
      if (!existsSync(file)) continue;
      const record: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(record) || record.schemaVersion !== 1 || record.sample !== sample
        || !isRecord(record.target) || record.target.name !== target.name
        || !isRecord(record.execution) || !["completed", "failed", "timeout"].includes(String(record.execution.status))
        || typeof record.execution.latencyMs !== "number" || !isRecord(record.grade)
        || !["passed", "failed", "not-run", "error"].includes(String(record.grade.status)) || !Array.isArray(record.changes)) throw new Error(`损坏的采样结果：${file}`);
      records.push(record as BenchRunRecord);
    }
  }
  return { dir, spec, records };
}

export function listBenchmarks(root: string): { entries: Array<{ spec: BenchSpec; completed: number }>; warnings: string[] } {
  const base = benchmarksDir(root);
  if (!existsSync(base)) return { entries: [], warnings: [] };
  const entries: Array<{ spec: BenchSpec; completed: number }> = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("b_")) continue;
    try {
      const { spec, records } = readBenchmark(root, entry.name);
      entries.push({ spec, completed: records.length });
    } catch (error) {
      warnings.push(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  entries.sort((a, b) => b.spec.createdAt.localeCompare(a.spec.createdAt));
  return { entries, warnings };
}
