import type {
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  ConfigSnapshot,
  SessionNode,
  TokenUsage,
  VariantScore,
} from "../types.ts";

/**
 * 落盘 JSON → 类型。老文件缺字段时给默认值，新字段只加不删，
 * 保证历史 data/ 一直能读。store 与测试 fixture 共用这一份。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseConfigSnapshot(raw: unknown, field = "config"): ConfigSnapshot {
  if (!isRecord(raw)) {
    throw new Error(`${field} 格式无效`);
  }
  return {
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
  };
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

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseVariantScore(raw: unknown): VariantScore {
  if (!isRecord(raw)) {
    throw new Error("scores.variants[] 格式无效");
  }
  const ratio = nullableNumber(raw.changeRatio);
  if (ratio === null) {
    throw new Error("scores.variants[].changeRatio 必须是数字");
  }
  return {
    configName: requireString(raw.configName, "configName"),
    similarity: nullableNumber(raw.similarity),
    changeRatio: ratio,
    barelyChanged: raw.barelyChanged === true,
  };
}

export function parseComparisonScores(raw: unknown): ComparisonScores {
  if (!isRecord(raw) || !Array.isArray(raw.variants)) {
    throw new Error("scores.json 格式无效");
  }
  return {
    comparisonId: requireString(raw.comparisonId, "comparisonId"),
    reference: requireNullableString(raw.reference, "reference"),
    baseline: requireNullableString(raw.baseline, "baseline"),
    scoredAt: requireString(raw.scoredAt, "scoredAt"),
    variants: raw.variants.map((item) => parseVariantScore(item)),
  };
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
  };
}
