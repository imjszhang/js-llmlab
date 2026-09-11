import chalk from "chalk";
import type {
  ComparisonSpec,
  ComparisonVariant,
  DryRunEntry,
  SharedCliOptions,
} from "../types.ts";
import { buildChatRequest } from "../lib/client.ts";
import {
  collectConfigRefs,
  compareOverridesFromCli,
  dedupeConfigRefs,
  loadEnv,
  peekConfigRef,
  resolveConfigRef,
  safeVariantName,
} from "../lib/config.ts";
import { mapWithConcurrency, parseConcurrency } from "../lib/concurrency.ts";
import { createId } from "../lib/ids.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import {
  renderComparisonReport,
  renderDryRun,
  renderSummaryTable,
  truncateTitle,
} from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { ancestorChain, appendTurn, buildApiMessages, forkBranch } from "../lib/tree.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

export async function runCompare(options: SharedCliOptions, deps?: CommandDeps): Promise<void> {
  const { root, complete, log } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);

  const named = collectConfigRefs(options, root);
  if (named.length < 2) {
    throw new Error(
      "compare 需要至少两个配置或模型，例如 --configs deepseek,gpt-4o 或 --models deepseek-chat,gpt-4o",
    );
  }
  const overrides = compareOverridesFromCli(options);
  // 名字不同、解析后相同的路只跑一次（例如 --configs ds-v4-flash --models deepseek-v4-flash）。
  const { kept: refs, dropped } = dedupeConfigRefs(root, named, overrides);
  for (const { ref, sameAs } of dropped) {
    log(chalk.yellow(`去重：${ref} 解析后与 ${sameAs} 相同，只跑一路`));
  }

  const systemName = options.system ?? "default";
  const userName = options.user ?? null;
  const input = readMessageInput(options.message, options.input);
  const userText = resolveUserText({
    root,
    userPreset: userName,
    input,
    mode: "run",
  });
  const systemText = resolveSystemText(root, systemName);
  const concurrency = parseConcurrency(options.concurrency);

  if (options.dryRun === true) {
    // 不要 key、不建会话、不写 data/。带 --session/--from 时只读祖先链。
    const sessionId = options.session;
    const fromNodeId = options.from ?? null;
    const ancestors =
      sessionId !== undefined && fromNodeId !== null && store.sessionExists(sessionId)
        ? ancestorChain(store, sessionId, fromNodeId)
        : [];
    const messages = buildApiMessages(systemText, ancestors, userText);
    const entries: DryRunEntry[] = refs.map((ref) => {
      const peeked = peekConfigRef(root, ref, overrides);
      return {
        ref,
        config: peeked.snapshot,
        apiKeyEnv: peeked.apiKeyEnv,
        apiKeyPresent: peeked.apiKeyPresent,
        messages,
        request: buildChatRequest(peeked.snapshot, messages, false),
      };
    });
    log(renderDryRun(entries));
    return;
  }

  store.ensureLayout();
  let sessionId = options.session;
  if (sessionId === undefined) {
    const session = store.createSession({
      title: truncateTitle(`compare: ${refs.join(",")}`),
      defaultConfig: refs[0] ?? "default",
      defaultSystem: systemName,
    });
    sessionId = session.id;
  } else if (!store.sessionExists(sessionId)) {
    throw new Error(`找不到会话：${sessionId}`);
  }

  const fromNodeId = options.from ?? null;
  if (fromNodeId !== null) {
    store.getNode(sessionId, fromNodeId);
  }

  const spec: ComparisonSpec = {
    id: createId("c"),
    createdAt: new Date().toISOString(),
    configs: refs,
    systemPreset: systemName,
    userPreset: userName,
    input: userText,
    sessionId,
    fromNodeId,
  };

  // 先把每路的配置与分支准备好（同步、按输入顺序），再并发发请求。
  const tasks = refs.map((ref) => {
    const config = resolveConfigRef(root, ref, overrides);
    const branchName = safeVariantName(ref);
    if (!store.branchExists(sessionId, branchName)) {
      forkBranch(store, sessionId, branchName, fromNodeId);
    } else {
      store.writeBranch(sessionId, {
        ...store.getBranch(sessionId, branchName),
        head: fromNodeId,
      });
    }
    return { ref, config, branchName };
  });

  const startedAt = Date.now();
  log(chalk.dim(`${String(tasks.length)} 路，并发 ${String(concurrency)}`));
  const variants = await mapWithConcurrency(tasks, concurrency, async (task) => {
    log(chalk.dim(`开始 ${task.ref} → ${task.config.model}`));
    const begin = Date.now();
    const node = await appendTurn({
      store,
      sessionId,
      branchName: task.branchName,
      parentId: fromNodeId,
      config: task.config,
      systemText,
      systemPreset: systemName,
      userPreset: userName,
      userText,
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
  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  const report = renderComparisonReport(spec, variants);
  const dir = store.writeComparison(spec, variants, report);
  log("");
  log(renderSummaryTable(variants));
  log("");
  log(chalk.dim(`总耗时 ${totalSeconds}s，已写入 ${dir}（report.md 含各路成稿，思维链在 variants/<配置>/reasoning.md）`));
}
