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
  loadEnv,
  peekConfigRef,
  resolveConfigRef,
  safeVariantName,
} from "../lib/config.ts";
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

  const refs = collectConfigRefs(options, root);
  if (refs.length < 2) {
    throw new Error(
      "compare 需要至少两个配置或模型，例如 --configs deepseek,gpt-4o 或 --models deepseek-chat,gpt-4o",
    );
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
  const overrides = compareOverridesFromCli(options);

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

  const variants: ComparisonVariant[] = [];
  for (const ref of refs) {
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

    log(chalk.dim(`运行 ${ref} → ${config.model}...`));
    const node = await appendTurn({
      store,
      sessionId,
      branchName,
      parentId: fromNodeId,
      config,
      systemText,
      systemPreset: systemName,
      userPreset: userName,
      userText,
      complete,
    });
    variants.push({
      configName: ref,
      config: node.config,
      assistant: node.messages.assistant,
      reasoning: node.messages.reasoning,
      usage: node.usage,
      latencyMs: node.latencyMs,
      error: node.error,
      nodeId: node.id,
    });
    if (node.error !== null) {
      log(chalk.red(`${ref} 失败：${node.error}`));
    }
  }

  const report = renderComparisonReport(spec, variants);
  const dir = store.writeComparison(spec, variants, report);
  log("");
  log(renderSummaryTable(variants));
  log("");
  log(chalk.dim(`已写入 ${dir}（report.md 含各路成稿，思维链在 variants/<配置>/reasoning.md）`));
}
