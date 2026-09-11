import type {
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  ConfigSnapshot,
  Cost,
  JudgeVerdict,
  Pricing,
  SessionNode,
  TokenUsage,
  VariantScore,
} from "../types.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./config.ts";

/**
 * 落盘 JSON → 类型。老文件缺字段时给默认值，新字段只加不删，
 * 保证历史 data/ 一直能读。store 与测试 fixture 共用这一份。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`字段 ${field} 必须是字符串`);
  }
  return value;
}

export function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireString(value, field);
}

export function parseUsage(raw: unknown): TokenUsage | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!isRecord(raw)) {
    throw new Error("usage 格式无效");
  }
  return {
    promptTokens: Number(raw.promptTokens),
    completionTokens: Number(raw.completionTokens),
    totalTokens: Number(raw.totalTokens),
    reasoningTokens:
      raw.reasoningTokens === undefined || raw.reasoningTokens === null
        ? null
        : Number(raw.reasoningTokens),
  };
}

export function parsePricingRecord(raw: unknown): Pricing | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const inputPerMillion = nullableNumber(raw.inputPerMillion);
  const outputPerMillion = nullableNumber(raw.outputPerMillion);
  if (inputPerMillion === null || outputPerMillion === null) {
    return undefined;
  }
  return {
    inputPerMillion,
    outputPerMillion,
    currency: typeof raw.currency === "string" ? raw.currency : "CNY",
  };
}

/** 老节点没有 cost 字段 → null。 */
export function parseCost(raw: unknown): Cost | null {
  if (!isRecord(raw)) {
    return null;
  }
  const input = nullableNumber(raw.input);
  const output = nullableNumber(raw.output);
  const total = nullableNumber(raw.total);
  if (input === null || output === null || total === null) {
    return null;
  }
  return {
    input,
    output,
    total,
    currency: typeof raw.currency === "string" ? raw.currency : "CNY",
  };
}

export function parseConfigSnapshot(raw: unknown, field = "config"): ConfigSnapshot {
  if (!isRecord(raw)) {
    throw new Error(`${field} 格式无效`);
  }
  const snapshot: ConfigSnapshot = {
    name: requireString(raw.name, `${field}.name`),
    provider: requireNullableString(raw.provider, `${field}.provider`),
    baseURL: requireString(raw.baseURL, `${field}.baseURL`),
    model: requireString(raw.model, `${field}.model`),
    temperature: Number(raw.temperature),
    maxTokens: Number(raw.maxTokens),
    thinking: raw.thinking === "enabled" || raw.thinking === "disabled" ? raw.thinking : null,
    reasoningEffort:
      raw.reasoningEffort === "low" || raw.reasoningEffort === "high" || raw.reasoningEffort === "max"
        ? raw.reasoningEffort
        : null,
    // 老快照没有这两项 → 默认值。
    timeoutMs: nullableNumber(raw.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
    maxRetries: nullableNumber(raw.maxRetries) ?? DEFAULT_MAX_RETRIES,
  };
  const pricing = parsePricingRecord(raw.pricing);
  if (pricing !== undefined) {
    snapshot.pricing = pricing;
  }
  return snapshot;
}

export function parseSessionNode(raw: unknown): SessionNode {
  if (!isRecord(raw) || !isRecord(raw.messages)) {
    throw new Error("node JSON 格式无效");
  }
  return {
    id: requireString(raw.id, "id"),
    parentId: requireNullableString(raw.parentId, "parentId"),
    createdAt: requireString(raw.createdAt, "createdAt"),
    config: parseConfigSnapshot(raw.config),
    systemPreset: requireNullableString(raw.systemPreset, "systemPreset"),
    userPreset: requireNullableString(raw.userPreset, "userPreset"),
    messages: {
      system: requireString(raw.messages.system, "messages.system"),
      user: requireString(raw.messages.user, "messages.user"),
      assistant: requireString(raw.messages.assistant, "messages.assistant"),
      reasoning: requireNullableString(raw.messages.reasoning, "messages.reasoning"),
    },
    usage: parseUsage(raw.usage),
    latencyMs: Number(raw.latencyMs),
    error: requireNullableString(raw.error, "error"),
    cost: parseCost(raw.cost),
    requestId: requireNullableString(raw.requestId, "requestId"),
  };
}

export function parseComparisonSpec(raw: unknown): ComparisonSpec {
  if (!isRecord(raw) || !Array.isArray(raw.configs)) {
    throw new Error("spec.json 格式无效");
  }
  return {
    id: requireString(raw.id, "id"),
    createdAt: requireString(raw.createdAt, "createdAt"),
    configs: raw.configs.map((item, index) => requireString(item, `configs[${String(index)}]`)),
    systemPreset: requireNullableString(raw.systemPreset, "systemPreset"),
    userPreset: requireNullableString(raw.userPreset, "userPreset"),
    input: requireString(raw.input, "input"),
    sessionId: requireNullableString(raw.sessionId, "sessionId"),
    fromNodeId: requireNullableString(raw.fromNodeId, "fromNodeId"),
  };
}

export function parseJudgeVerdict(raw: unknown): JudgeVerdict {
  if (!isRecord(raw)) {
    throw new Error("judge 格式无效");
  }
  return {
    score: nullableNumber(raw.score),
    reason: requireNullableString(raw.reason, "judge.reason"),
    error: requireNullableString(raw.error, "judge.error"),
    nodeId: requireNullableString(raw.nodeId, "judge.nodeId"),
    usage: parseUsage(raw.usage),
    latencyMs: Number(raw.latencyMs ?? 0),
  };
}

export function parseVariantScore(raw: unknown): VariantScore {
  if (!isRecord(raw)) {
    throw new Error("scores.variants[] 格式无效");
  }
  const ratio = nullableNumber(raw.changeRatio);
  if (ratio === null) {
    throw new Error("scores.variants[].changeRatio 必须是数字");
  }
  const score: VariantScore = {
    configName: requireString(raw.configName, "configName"),
    similarity: nullableNumber(raw.similarity),
    changeRatio: ratio,
    barelyChanged: raw.barelyChanged === true,
  };
  if (raw.judge !== undefined && raw.judge !== null) {
    score.judge = parseJudgeVerdict(raw.judge);
  }
  return score;
}

export function parseComparisonScores(raw: unknown): ComparisonScores {
  if (!isRecord(raw) || !Array.isArray(raw.variants)) {
    throw new Error("scores.json 格式无效");
  }
  const scores: ComparisonScores = {
    comparisonId: requireString(raw.comparisonId, "comparisonId"),
    reference: requireNullableString(raw.reference, "reference"),
    baseline: requireNullableString(raw.baseline, "baseline"),
    scoredAt: requireString(raw.scoredAt, "scoredAt"),
    variants: raw.variants.map((item) => parseVariantScore(item)),
  };
  if (isRecord(raw.judge)) {
    scores.judge = {
      config: parseConfigSnapshot(raw.judge.config, "judge.config"),
      rubric: requireString(raw.judge.rubric, "judge.rubric"),
      sessionId: requireString(raw.judge.sessionId, "judge.sessionId"),
    };
  }
  return scores;
}

/** 完整的一路结果（含成稿），fixture 与 readComparison 的产物都走这里。 */
export function parseComparisonVariant(raw: unknown): ComparisonVariant {
  if (!isRecord(raw)) {
    throw new Error("variant 格式无效");
  }
  return {
    configName: requireString(raw.configName, "configName"),
    config: parseConfigSnapshot(raw.config),
    assistant: typeof raw.assistant === "string" ? raw.assistant : "",
    reasoning: requireNullableString(raw.reasoning, "reasoning"),
    usage: parseUsage(raw.usage),
    latencyMs: Number(raw.latencyMs),
    error: requireNullableString(raw.error, "error"),
    nodeId: requireNullableString(raw.nodeId, "nodeId"),
    cost: parseCost(raw.cost),
    requestId: requireNullableString(raw.requestId, "requestId"),
  };
}
