import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { benchmarkDir, sampleDir, readBenchmark } from "./store.ts";

export type ReviewedUsage = { label: string; source: string; promptTokens: number; completionTokens: number; totalTokens: number; promptCacheHitTokens?: number };
export type ReportReview = {
  benchmarkId: string; target: string; sample: number; recordSha256: string; specSha256: string;
  reviewer: string; method: "human" | "agent-assisted"; reviewedAt: string;
  verdict: "unreviewed" | "accepted" | "needs-work" | "rejected";
  notes: string; evidence: string[];
  scores: Array<{ dimension: string; score: number; max: number }>;
  usageAlternatives: ReviewedUsage[];
};
export type ReportSupplement = { schemaVersion: 1; entries: ReportReview[] };
const digest = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

export function reviewFingerprints(root: string, benchmarkId: string, target: string, sample: number): { recordSha256: string; specSha256: string } {
  const dir = benchmarkDir(root, benchmarkId);
  return { recordSha256: digest(path.join(sampleDir(dir, target, sample), "record.json")), specSha256: digest(path.join(dir, "spec.json")) };
}

/** Template contains no model output or credentials. Files are written only by the command's exclusive create. */
export function reviewTemplate(root: string, id: string): ReportSupplement {
  const { records } = readBenchmark(root, id);
  return { schemaVersion: 1, entries: records.map((record) => ({ benchmarkId: id, target: record.target.name, sample: record.sample,
    ...reviewFingerprints(root, id, record.target.name, record.sample), reviewer: "", method: "human", reviewedAt: "", verdict: "unreviewed",
    notes: "", evidence: [], scores: [], usageAlternatives: [] })) };
}

export function readReportSupplement(root: string, file: string, benchmarkIds: readonly string[]): { sha256: string; snapshot: ReportSupplement } {
  const bytes = readFileSync(file);
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) throw new Error("评审附件必须为 schemaVersion=1 / entries 数组");
  const seen = new Set<string>();
  for (const entry of raw.entries) {
    if (!object(entry) || !text(entry.benchmarkId) || !benchmarkIds.includes(entry.benchmarkId) || !text(entry.target) || !count(entry.sample) || entry.sample < 1
      || typeof entry.method !== "string" || !["human", "agent-assisted"].includes(entry.method)
      || typeof entry.verdict !== "string" || !["unreviewed", "accepted", "needs-work", "rejected"].includes(entry.verdict)
      || typeof entry.reviewer !== "string" || typeof entry.reviewedAt !== "string"
      || typeof entry.notes !== "string" || !Array.isArray(entry.evidence) || !entry.evidence.every(text) || !Array.isArray(entry.scores) || !Array.isArray(entry.usageAlternatives)) throw new Error("无效评审附件条目或实验不在本次报告中");
    const key = `${entry.benchmarkId}/${entry.target}/${entry.sample}`;
    if (seen.has(key)) throw new Error(`重复评审：${key}`);
    seen.add(key);
    const frozen = readBenchmark(root, entry.benchmarkId).spec;
    if (!frozen.targets.some((t) => t.name === entry.target) || entry.sample > frozen.repeat) throw new Error(`评审样本不存在：${key}`);
    const target = frozen.targets.find((t) => t.name === entry.target);
    if (target?.kind === "harness" && (target.backend.auth === "cursor-login" || target.backend.auth === "cursor-api-key") && entry.usageAlternatives.length) throw new Error("Cursor 完整用量尚未验证，评审附件不能提供核对用量；原始事件仅供审计");
    const fingerprints = reviewFingerprints(root, entry.benchmarkId, entry.target, entry.sample);
    if (entry.recordSha256 !== fingerprints.recordSha256 || entry.specSha256 !== fingerprints.specSha256) throw new Error(`评审指纹不匹配：${key}`);
    const active = entry.verdict !== "unreviewed" || entry.usageAlternatives.length > 0;
    if (active && (!text(entry.reviewer) || !text(entry.reviewedAt) || !Number.isFinite(Date.parse(entry.reviewedAt)) || entry.evidence.length === 0)) throw new Error(`评审需填写评审人、日期、证据：${key}`);
    if (entry.verdict === "unreviewed" && entry.scores.length) throw new Error("未评审条目不能包含评分");
    const dimensions = new Set<string>();
    for (const score of entry.scores) {
      if (!object(score) || !text(score.dimension) || typeof score.score !== "number" || typeof score.max !== "number" || !Number.isFinite(score.max) || !Number.isFinite(score.score) || score.max <= 0 || score.score < 0 || score.score > score.max || dimensions.has(score.dimension)) throw new Error("无效或重复评审评分");
      dimensions.add(score.dimension);
    }
    const labels = new Set<string>();
    for (const value of entry.usageAlternatives) {
      if (!object(value) || !text(value.label) || !text(value.source) || labels.has(value.label) || !count(value.promptTokens) || !count(value.completionTokens) || !count(value.totalTokens)
        || value.totalTokens !== value.promptTokens + value.completionTokens || (value.promptCacheHitTokens !== undefined && (!count(value.promptCacheHitTokens) || value.promptCacheHitTokens > value.promptTokens))) throw new Error("无效核对用量；输入须已含缓存、输出须已含推理");
      labels.add(value.label);
    }
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), snapshot: raw as ReportSupplement };
}
