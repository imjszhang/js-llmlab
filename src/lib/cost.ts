import type { Cost, Pricing, TokenUsage } from "../types.ts";

/**
 * 按配置里的 pricing 算一次调用的花费。
 * OpenAI 兼容口径下 completion_tokens 已含推理 token，所以推理按 output 计价，不重复算。
 * 命中数与命中价均已知时分开计价；其余输入（包括未报告的缓存统计）按统一输入价计。
 * 没 pricing 或没 usage 就是 null，而不是 0。
 */
export function computeCost(usage: TokenUsage | null, pricing: Pricing | undefined): Cost | null {
  if (usage === null || pricing === undefined) {
    return null;
  }
  const hit = usage.promptCacheHitTokens;
  const miss = usage.promptCacheMissTokens;
  const validHit = hit !== undefined && Number.isSafeInteger(hit) && hit >= 0 && hit <= usage.promptTokens;
  const validMiss = miss === undefined || (
    Number.isSafeInteger(miss) && miss >= 0 && miss <= usage.promptTokens &&
    (hit === undefined || hit + miss <= usage.promptTokens)
  );
  // 不从 miss 反推 hit：旧网关或不完整统计不能凭空享受缓存折扣。
  const cached = validHit && validMiss && pricing.cachedInputPerMillion !== undefined ? hit : 0;
  const input = (
    (usage.promptTokens - cached) * pricing.inputPerMillion +
    cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
  ) / 1_000_000;
  const output = (usage.completionTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    input,
    output,
    total: input + output,
    currency: pricing.currency,
  };
}

/** 表格 / turn md 用：`0.0060 CNY`；≥ 1 时两位小数。 */
export function formatCost(cost: Cost | null | undefined): string {
  if (cost === null || cost === undefined) {
    return "-";
  }
  const digits = cost.total >= 1 ? 2 : 4;
  return `${cost.total.toFixed(digits)} ${cost.currency}`;
}
