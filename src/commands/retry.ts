import chalk from "chalk";
import type { ComparisonVariant, ResolvedConfig } from "../types.ts";
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
  const targets = only.length > 0 ? variants.filter((v) => only.includes(v.configName)) : variants.filter((v) => v.error !== null);
  if (targets.length === 0) {
    log(chalk.dim(`对比 ${comparisonId} 没有失败的路，无需补跑（要强制重跑用 --only a,b）`));
    return;
  }

  const timeoutMs = parseTimeoutMs(options.timeoutMs);
  const maxRetries = parseMaxRetries(options.maxRetries);
  const concurrency = parseConcurrency(options.concurrency);

  // 准备每路：原快照 + 密钥；分支头回到 fromNodeId，新节点仍以它为父。
  const tasks = targets.map((variant) => {
    const nodeId = variant.nodeId;
    if (nodeId === null) {
      throw new Error(`对比 ${comparisonId} 的 ${variant.configName} 没有节点，无法补跑`);
    }
    const previous = store.getNode(sessionId, nodeId);
    const peeked = peekConfigRef(root, variant.configName);
    const apiKey = process.env[peeked.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`缺少 API Key：请设置环境变量 ${peeked.apiKeyEnv}（可复制 .env.example 为 .env）`);
    }
    const config: ResolvedConfig = { ...previous.config, apiKey, apiKeyEnv: peeked.apiKeyEnv };
    if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
    if (maxRetries !== undefined) config.maxRetries = maxRetries;
    const branchName = safeVariantName(variant.configName);
    if (!store.branchExists(sessionId, branchName)) {
      forkBranch(store, sessionId, branchName, spec.fromNodeId);
    } else {
      store.writeBranch(sessionId, { ...store.getBranch(sessionId, branchName), head: spec.fromNodeId });
    }
    return { ref: variant.configName, config, branchName, systemText: previous.messages.system };
  });

  log(chalk.dim(`补跑 ${String(tasks.length)} 路：${tasks.map((t) => t.ref).join(", ")}，并发 ${String(concurrency)}`));
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
      log(chalk.red(`失败 ${task.ref} ${elapsed}s：${node.error}`));
    } else {
      log(chalk.dim(`完成 ${task.ref} ${elapsed}s`));
    }
    const variant: ComparisonVariant = {
      configName: task.ref,
      config: node.config,
      assistant: node.messages.assistant,
      reasoning: node.messages.reasoning,
      usage: node.usage,
      latencyMs: node.latencyMs,
      error: node.error,
      nodeId: node.id,
      cost: node.cost,
      requestId: node.requestId,
    };
    return variant;
  });
  store.touchSession(sessionId);

  const byName = new Map(reran.map((v) => [v.configName, v]));
  const merged = variants.map((v) => byName.get(v.configName) ?? v);
  for (const variant of reran) {
    store.writeVariant(spec.id, variant);
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
