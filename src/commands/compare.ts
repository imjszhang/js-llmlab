import chalk from "chalk";
import type { ComparisonSpec, ComparisonVariant, SharedCliOptions } from "../types.ts";
import {
  collectConfigRefs,
  compareOverridesFromCli,
  loadEnv,
  resolveConfigRef,
  safeVariantName,
} from "../lib/config.ts";
import { createId } from "../lib/ids.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { renderComparisonReport, truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn, forkBranch } from "../lib/tree.ts";

export async function runCompare(options: SharedCliOptions): Promise<void> {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  store.ensureLayout();

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

    console.log(chalk.dim(`运行 ${ref} → ${config.model}...`));
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
      console.log(chalk.red(`${ref} 失败：${node.error}`));
    }
  }

  const report = renderComparisonReport(spec, variants);
  const dir = store.writeComparison(spec, variants, report);
  console.log(report);
  console.log(chalk.dim(`已写入 ${dir}`));
}
