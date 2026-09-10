import chalk from "chalk";
import type { SharedCliOptions } from "../types.ts";
import { loadEnv, overridesFromCli, resolveConfig } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn } from "../lib/tree.ts";

export async function runOnce(options: SharedCliOptions): Promise<void> {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  store.ensureLayout();

  const configName = options.config ?? "default";
  const config = resolveConfig(root, configName, overridesFromCli(options));
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

  let sessionId = options.session;
  if (sessionId === undefined) {
    const session = store.createSession({
      title: truncateTitle(userText),
      defaultConfig: configName,
      defaultSystem: systemName,
    });
    sessionId = session.id;
    console.log(chalk.dim(`新建会话 ${sessionId}`));
  } else if (!store.sessionExists(sessionId)) {
    throw new Error(`找不到会话：${sessionId}`);
  }

  const branchName = options.branch ?? "main";
  if (!store.branchExists(sessionId, branchName)) {
    throw new Error(`找不到分支：${branchName}`);
  }

  const node = await appendTurn({
    store,
    sessionId,
    branchName,
    config,
    systemText,
    systemPreset: systemName,
    userPreset: userName,
    userText,
  });

  if (node.error !== null) {
    console.error(chalk.red(`请求失败：${node.error}`));
    console.error(chalk.dim(`已落盘 ${node.id}`));
    process.exitCode = 1;
    return;
  }

  console.log(node.messages.assistant);
  console.log(chalk.dim(`\nsession=${sessionId} branch=${branchName} node=${node.id} ${String(node.latencyMs)}ms`));
}
