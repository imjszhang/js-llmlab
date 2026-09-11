import chalk from "chalk";
import type { SharedCliOptions } from "../types.ts";
import { loadEnv, overridesFromCli, resolveConfigRef } from "../lib/config.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn } from "../lib/tree.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

export async function runOnce(options: SharedCliOptions, deps?: CommandDeps): Promise<void> {
  const { root, complete, log, error } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  store.ensureLayout();

  const configName = options.config ?? "ds-chat";
  const config = resolveConfigRef(root, configName, overridesFromCli(options));
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
    log(chalk.dim(`新建会话 ${sessionId}`));
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
    complete,
  });

  if (node.error !== null) {
    error(chalk.red(`请求失败：${node.error}`));
    error(chalk.dim(`已落盘 ${node.id}`));
    process.exitCode = 1;
    return;
  }

  log(node.messages.assistant);
  log(chalk.dim(`\nsession=${sessionId} branch=${branchName} node=${node.id} ${String(node.latencyMs)}ms`));
}
