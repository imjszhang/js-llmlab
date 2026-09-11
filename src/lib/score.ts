import type {
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  VariantScore,
} from "../types.ts";
import { changeRatio, similarity } from "./similarity.ts";

export const BARELY_CHANGED_THRESHOLD = 0.05;

/**
 * 对一次对比的各路算离线指标。纯函数、无 IO、无网络，同一输入结果完全一致。
 * `referenceText` 为 null 时 `similarity` 为 null；`baselineText` 缺省用 spec.input。
 */
export function scoreVariants(params: {
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
  referenceText: string | null;
  baselineText?: string;
}): VariantScore[] {
  const baseline = params.baselineText ?? params.spec.input;
  return params.variants.map((variant) => {
    const ratio = changeRatio(variant.assistant, baseline);
    return {
      configName: variant.configName,
      similarity: params.referenceText === null ? null : similarity(variant.assistant, params.referenceText),
      changeRatio: ratio,
      barelyChanged: ratio < BARELY_CHANGED_THRESHOLD,
    };
  });
}

export function buildScores(params: {
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
  referenceText: string | null;
  referencePath: string | null;
  baselineText?: string;
  baselinePath: string | null;
  scoredAt?: string;
}): ComparisonScores {
  const scoreParams: Parameters<typeof scoreVariants>[0] = {
    spec: params.spec,
    variants: params.variants,
    referenceText: params.referenceText,
  };
  if (params.baselineText !== undefined) {
    scoreParams.baselineText = params.baselineText;
  }
  return {
    comparisonId: params.spec.id,
    reference: params.referencePath,
    baseline: params.baselinePath,
    scoredAt: params.scoredAt ?? new Date().toISOString(),
    variants: scoreVariants(scoreParams),
  };
}
