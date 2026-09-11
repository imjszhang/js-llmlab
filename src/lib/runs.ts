import type { ComparisonVariant, ConfigSnapshot, SessionNode, VariantRun } from "../types.ts";

/** `--repeat <n>`：必须是 ≥ 1 的整数；缺省 1。 */
export function parseRepeat(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 1;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--repeat 需要 ≥ 1 的整数，收到 ${value}`);
  }
  return n;
}

export function runFromNode(node: SessionNode): VariantRun {
  return {
    nodeId: node.id,
    assistant: node.messages.assistant,
    reasoning: node.messages.reasoning,
    usage: node.usage,
    latencyMs: node.latencyMs,
    error: node.error,
    cost: node.cost,
    requestId: node.requestId,
  };
}

/** 一路的全部采样：有 `runs` 用它，否则这一路自己就是唯一的 run。 */
export function variantRuns(variant: ComparisonVariant): VariantRun[] {
  if (variant.runs !== undefined && variant.runs.length > 0) {
    return variant.runs;
  }
  return [
    {
      nodeId: variant.nodeId,
      assistant: variant.assistant,
      reasoning: variant.reasoning,
      usage: variant.usage,
      latencyMs: variant.latencyMs,
      error: variant.error,
      cost: variant.cost,
      requestId: variant.requestId,
    },
  ];
}

/**
 * 由若干采样拼一路：顶层 = 第 1 次；多于一次才带 `runs`，
 * 所以 `--repeat 1` 的落盘与不带参数完全一样。
 */
export function variantFromRuns(configName: string, config: ConfigSnapshot, runs: VariantRun[]): ComparisonVariant {
  const first = runs[0];
  if (first === undefined) {
    throw new Error(`${configName} 没有任何采样`);
  }
  const variant: ComparisonVariant = { configName, config, ...first };
  if (runs.length > 1) {
    variant.runs = runs;
  }
  return variant;
}

export type Stat = { mean: number; min: number; max: number; count: number };

/** 忽略 null；没有值时返回 null。 */
export function stat(values: Array<number | null | undefined>): Stat | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) {
    return null;
  }
  return {
    mean: nums.reduce((a, b) => a + b, 0) / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    count: nums.length,
  };
}
