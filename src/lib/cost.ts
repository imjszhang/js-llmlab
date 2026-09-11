import type { Cost, Pricing, TokenUsage } from "../types.ts";

/**
 * 按配置里的 pricing 算一次调用的花费。
 * OpenAI 兼容口径下 completion_tokens 已含推理 token，所以推理按 output 计价，不重复算。
 * 没 pricing 或没 usage 就是 null，而不是 0。
 */
export function computeCost(usage: TokenUsage | null, pricing: Pricing | undefined): Cost | null {
  if (usage === null || pricing === undefined) {
    return null;
  }
  const input = (usage.promptTokens / 1_000_000) * pricing.inputPerMillion;
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
