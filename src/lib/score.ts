import type {
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  VariantScore,
} from "../types.ts";
import { stat, variantRuns } from "./runs.ts";
import { changeRatio, similarity } from "./similarity.ts";

export const BARELY_CHANGED_THRESHOLD = 0.05;

/**
 * 对一次对比的各路算离线指标。纯函数、无 IO、无网络，同一输入结果完全一致。
 * `referenceText` 为 null 时 `similarity` 为 null；`baselineText` 缺省用 spec.input。
 * `--repeat` 的路：每次成功的采样分别算，顶层取均值，`runs` 保留逐次值。
 */
export function scoreVariants(params: {
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
  referenceText: string | null;
  baselineText?: string;
}): VariantScore[] {
  const baseline = params.baselineText ?? params.spec.input;
  const measure = (text: string): { similarity: number | null; changeRatio: number } => ({
    similarity: params.referenceText === null ? null : similarity(text, params.referenceText),
    changeRatio: changeRatio(text, baseline),
  });
  return params.variants.map((variant) => {
    const runs = variantRuns(variant);
    if (runs.length === 1) {
      const m = measure(variant.assistant);
      return {
        configName: variant.configName,
        similarity: m.similarity,
        changeRatio: m.changeRatio,
        barelyChanged: m.changeRatio < BARELY_CHANGED_THRESHOLD,
      };
    }
    // 只算成功的采样；全失败就退回第 1 次（与单次的口径一致）。
    const scored = runs.filter((r) => r.error === null);
    const pool = scored.length > 0 ? scored : runs.slice(0, 1);
    const perRun = pool.map((run) => ({ nodeId: run.nodeId, ...measure(run.assistant) }));
    const ratio = stat(perRun.map((r) => r.changeRatio))?.mean ?? 1;
    const sim = params.referenceText === null ? null : (stat(perRun.map((r) => r.similarity))?.mean ?? null);
    const score: VariantScore = {
      configName: variant.configName,
      similarity: sim,
      changeRatio: ratio,
      barelyChanged: ratio < BARELY_CHANGED_THRESHOLD,
    };
    if (perRun.length > 1) {
      score.runs = perRun;
    }
    return score;
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
