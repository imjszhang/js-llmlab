import chalk from "chalk";
import type { ComparisonVariant, ResolvedConfig, VariantRun } from "../types.ts";
import {
  loadEnv,
  parseMaxRetries,
  parseNameList,
  parseTimeoutMs,
  peekConfigRef,
  safeVariantName,
} from "../lib/config.ts";
import { mapWithConcurrency, parseConcurrency } from "../lib/concurrency.ts";
import { renderComparisonReport, renderSummaryTable } from "../lib/render.ts";
import { runFromNode, variantFromRuns, variantRuns } from "../lib/runs.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn, forkBranch } from "../lib/tree.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

export type RetryCliOptions = {
  /** 逗号分隔的配置名；给了就无论成败都重跑这些路。 */
  only?: string;
  concurrency?: string;
  timeoutMs?: string;
  maxRetries?: string;
};

/**
 * 补跑一次对比里失败的路。复用原 spec 的 input 与节点里记录的 system 文本，
 * 配置用原节点的快照（不重新解析文件，避免中途改过配置导致口径不一致），
 * 只允许覆盖 timeoutMs / maxRetries。
 */
export async function runCompareRetry(
  comparisonId: string,
  options: RetryCliOptions,
  deps?: CommandDeps,
): Promise<void> {
  const { root, complete, log } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  const { spec, variants, dir } = store.readComparison(comparisonId);
  const sessionId = spec.sessionId;
  if (sessionId === null) {
    throw new Error(`对比 ${comparisonId} 没有关联会话，无法补跑`);
  }

  const only = parseNameList(options.only);
  for (const name of only) {
    if (!spec.configs.includes(name)) {
      throw new Error(`--only 里的 ${name} 不在对比 ${comparisonId} 的配置中（${spec.configs.join(", ")}）`);
    }
  }
  // 目标是「采样」而不是「路」：--repeat 的路只补跑失败的那几次；--only 指定的路每一次都重跑。
  type Job = { variant: ComparisonVariant; runIndex: number; run: VariantRun };
  const jobs: Job[] = [];
  for (const variant of variants) {
    const runs = variantRuns(variant);
    const forced = only.includes(variant.configName);
    if (only.length > 0 && !forced) {
      continue;
    }
    runs.forEach((run, runIndex) => {
      if (forced || run.error !== null) {
        jobs.push({ variant, runIndex, run });
      }
    });
  }
  if (jobs.length === 0) {
    log(chalk.dim(`对比 ${comparisonId} 没有失败的路，无需补跑（要强制重跑用 --only a,b）`));
    return;
  }

  const timeoutMs = parseTimeoutMs(options.timeoutMs);
  const maxRetries = parseMaxRetries(options.maxRetries);
  const concurrency = parseConcurrency(options.concurrency);
  const repeated = spec.repeat !== undefined && spec.repeat > 1;
  const label = (job: Job): string =>
    repeated ? `${job.variant.configName}#${String(job.runIndex + 1)}` : job.variant.configName;

  // 准备每个采样：原节点快照 + 当前密钥；分支头回到 fromNodeId，新节点仍以它为父。
  const tasks = jobs.map((job) => {
    const nodeId = job.run.nodeId;
    if (nodeId === null) {
      throw new Error(`对比 ${comparisonId} 的 ${label(job)} 没有节点，无法补跑`);
    }
    const previous = store.getNode(sessionId, nodeId);
    const peeked = peekConfigRef(root, job.variant.configName);
    const apiKey = process.env[peeked.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`缺少 API Key：请设置环境变量 ${peeked.apiKeyEnv}（可复制 .env.example 为 .env）`);
    }
    const config: ResolvedConfig = { ...previous.config, apiKey, apiKeyEnv: peeked.apiKeyEnv };
    if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
    if (maxRetries !== undefined) config.maxRetries = maxRetries;
    const branchName = safeVariantName(job.variant.configName);
    if (!store.branchExists(sessionId, branchName)) {
      forkBranch(store, sessionId, branchName, spec.fromNodeId);
    } else {
      store.writeBranch(sessionId, { ...store.getBranch(sessionId, branchName), head: spec.fromNodeId });
    }
    return { job, config, branchName, systemText: previous.messages.system };
  });

  log(chalk.dim(`补跑 ${String(tasks.length)} 个采样：${tasks.map((t) => label(t.job)).join(", ")}，并发 ${String(concurrency)}`));
  const startedAt = Date.now();
  const reran = await mapWithConcurrency(tasks, concurrency, async (task) => {
    const begin = Date.now();
    const node = await appendTurn({
      store,
      sessionId,
      branchName: task.branchName,
      parentId: spec.fromNodeId,
      config: task.config,
      systemText: task.systemText,
      systemPreset: spec.systemPreset,
      userPreset: spec.userPreset,
      userText: spec.input,
      complete,
      touchSession: false,
    });
    const elapsed = ((Date.now() - begin) / 1000).toFixed(1);
    if (node.error !== null) {
      log(chalk.red(`失败 ${label(task.job)} ${elapsed}s：${node.error}`));
    } else {
      log(chalk.dim(`完成 ${label(task.job)} ${elapsed}s`));
    }
    return { job: task.job, config: node.config, run: runFromNode(node) };
  });
  store.touchSession(sessionId);

  // 把新采样按位置放回各路，重建顶层字段（第 1 次）。
  const touched = new Set(reran.map((r) => r.job.variant.configName));
  const merged = variants.map((variant) => {
    if (!touched.has(variant.configName)) {
      return variant;
    }
    const runs = [...variantRuns(variant)];
    let config = variant.config;
    for (const r of reran) {
      if (r.job.variant.configName === variant.configName) {
        runs[r.job.runIndex] = r.run;
        if (r.job.runIndex === 0) {
          config = r.config;
        }
      }
    }
    return variantFromRuns(variant.configName, config, runs);
  });
  for (const variant of merged) {
    if (touched.has(variant.configName)) {
      store.writeVariant(spec.id, variant);
    }
  }
  const droppedScores = store.deleteScores(spec.id);
  store.writeComparisonReport(spec.id, renderComparisonReport(spec, merged));
  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  log("");
  log(renderSummaryTable(merged));
  log("");
  if (droppedScores) {
    log(chalk.yellow(`成稿变了，已删除 scores.json；需要的话重新 compare score ${spec.id}`));
  }
  log(chalk.dim(`总耗时 ${totalSeconds}s，已更新 ${dir}`));
}
