import chalk from "chalk";
import type { ComparisonSpec, ComparisonVariant, SharedCliOptions } from "../types.ts";
import { loadEnv, overridesFromCli, resolveConfig } from "../lib/config.ts";
import { createId } from "../lib/ids.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { renderComparisonReport, truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn, forkBranch } from "../lib/tree.ts";

export async function runCompare(
  options: SharedCliOptions & { configs?: string },
): Promise<void> {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  store.ensureLayout();

  const configNames = (options.configs ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (configNames.length < 2) {
    throw new Error("compare 需要至少两个配置，例如 --configs default,deepseek");
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
  const overrides = overridesFromCli(options);

  let sessionId = options.session;
  if (sessionId === undefined) {
    const session = store.createSession({
      title: truncateTitle(`compare: ${configNames.join(",")}`),
      defaultConfig: configNames[0] ?? "default",
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
    configs: configNames,
    systemPreset: systemName,
    userPreset: userName,
    input: userText,
    sessionId,
    fromNodeId,
  };

  const variants: ComparisonVariant[] = [];
  for (const configName of configNames) {
    const config = resolveConfig(root, configName, overrides);
    if (!store.branchExists(sessionId, configName)) {
      forkBranch(store, sessionId, configName, fromNodeId);
    } else {
      store.writeBranch(sessionId, {
        ...store.getBranch(sessionId, configName),
        head: fromNodeId,
      });
    }

    console.log(chalk.dim(`运行配置 ${configName}...`));
    const node = await appendTurn({
      store,
      sessionId,
      branchName: configName,
      parentId: fromNodeId,
      config,
      systemText,
      systemPreset: systemName,
      userPreset: userName,
      userText,
    });
    variants.push({
      configName,
      config: node.config,
      assistant: node.messages.assistant,
      usage: node.usage,
      latencyMs: node.latencyMs,
      error: node.error,
      nodeId: node.id,
    });
    if (node.error !== null) {
      console.log(chalk.red(`${configName} 失败：${node.error}`));
    }
  }

  const report = renderComparisonReport(spec, variants);
  const dir = store.writeComparison(spec, variants, report);
  console.log(report);
  console.log(chalk.dim(`已写入 ${dir}`));
}
