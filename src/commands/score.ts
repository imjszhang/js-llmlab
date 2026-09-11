import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseConcurrency } from "../lib/concurrency.ts";
import { loadEnv, resolveConfigRef } from "../lib/config.ts";
import { judgeComparison } from "../lib/judge.ts";
import { listPresets, loadPreset } from "../lib/presets.ts";
import { renderComparisonReport, renderSummaryTable } from "../lib/render.ts";
import { buildScores } from "../lib/score.ts";
import { LabStore } from "../lib/store.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

export type ScoreCliOptions = {
  reference?: string;
  baseline?: string;
  /** 裁判用的配置名或模型 id。 */
  judge?: string;
  /** prompts/judge/<name>.md，缺省 default。 */
  rubric?: string;
  concurrency?: string;
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
 * 不带 `--judge` 时不发任何请求；带 `--judge <config>` 时用该配置逐路评审。
 */
export async function runCompareScore(
  comparisonId: string,
  options: ScoreCliOptions,
  deps?: CommandDeps,
): Promise<void> {
  const { root, complete, log } = resolveDeps(deps);
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

  if (options.judge !== undefined) {
    const rubricName = options.rubric ?? "default";
    const available = listPresets(root, "judge");
    if (!available.includes(rubricName)) {
      throw new Error(
        `找不到裁判 rubric：${rubricName}。prompts/judge/ 下可用：${available.length > 0 ? available.join(", ") : "（空）"}`,
      );
    }
    const rubricTemplate = loadPreset(root, "judge", rubricName);
    const config = resolveConfigRef(root, options.judge, {});
    const { info, verdicts } = await judgeComparison({
      store,
      spec,
      variants,
      referenceText,
      rubricName,
      rubricTemplate,
      config,
      complete,
      concurrency: parseConcurrency(options.concurrency),
      log: (line) => {
        log(chalk.dim(line));
      },
    });
    scores.judge = info;
    for (const score of scores.variants) {
      const verdict = verdicts.get(score.configName);
      if (verdict !== undefined) {
        score.judge = verdict;
      }
    }
  }

  const scoresPath = store.writeScores(comparisonId, scores);
  store.writeComparisonReport(comparisonId, renderComparisonReport(spec, variants, scores));

  log(renderSummaryTable(variants, scores));
  log("");
  const barely = scores.variants.filter((s) => s.barelyChanged).map((s) => s.configName);
  if (barely.length > 0) {
    log(chalk.yellow(`几乎没改（改动率 < 5%）：${barely.join(", ")}`));
  }
  if (scores.judge !== undefined) {
    log(chalk.dim(`裁判 ${scores.judge.config.name} / rubric ${scores.judge.rubric}，会话 ${scores.judge.sessionId}`));
  }
  log(chalk.dim(`已写入 ${scoresPath}，report.md 汇总表已更新`));
}
