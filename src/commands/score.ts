import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "../lib/config.ts";
import { renderComparisonReport, renderSummaryTable } from "../lib/render.ts";
import { buildScores } from "../lib/score.ts";
import { LabStore } from "../lib/store.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

export type ScoreCliOptions = {
  reference?: string;
  baseline?: string;
};

function readTextFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`找不到${label}文件：${filePath}`);
  }
  return readFileSync(resolved, "utf8");
}

/**
 * `compare score <c_id>`：对已有对比算离线指标，写 scores.json，重写 report.md 的汇总表。
 * 不发任何请求。
 */
export async function runCompareScore(
  comparisonId: string,
  options: ScoreCliOptions,
  deps?: CommandDeps,
): Promise<void> {
  const { root, log } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  const { spec, variants } = store.readComparison(comparisonId);

  const referencePath = options.reference ?? null;
  const baselinePath = options.baseline ?? null;
  const referenceText = referencePath === null ? null : readTextFile(referencePath, "参考答案");
  const params: Parameters<typeof buildScores>[0] = {
    spec,
    variants,
    referenceText,
    referencePath,
    baselinePath,
  };
  if (baselinePath !== null) {
    params.baselineText = readTextFile(baselinePath, "基线");
  }
  const scores = buildScores(params);

  const scoresPath = store.writeScores(comparisonId, scores);
  store.writeComparisonReport(comparisonId, renderComparisonReport(spec, variants, scores));

  log(renderSummaryTable(variants, scores));
  log("");
  const barely = scores.variants.filter((s) => s.barelyChanged).map((s) => s.configName);
  if (barely.length > 0) {
    log(chalk.yellow(`几乎没改（改动率 < 5%）：${barely.join(", ")}`));
  }
  log(chalk.dim(`已写入 ${scoresPath}，report.md 汇总表已更新`));
  await Promise.resolve();
}
