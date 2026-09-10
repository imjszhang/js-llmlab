import chalk from "chalk";
import { loadEnv, overridesFromCli, peekConfigRef, resolveConfigRef } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { appendTurn } from "../lib/tree.ts";
import {
  createReadline,
  formatPrompt,
  handleSlashCommand,
  helpText,
  type ReplState,
} from "../lib/repl.ts";
import type { CliConfigOverrides, SharedCliOptions } from "../types.ts";

function withProvider(
  options: SharedCliOptions,
  providerName: string | null,
): CliConfigOverrides {
  const overrides = overridesFromCli(options);
  if (providerName !== null) {
    overrides.provider = providerName;
  }
  return overrides;
}

export async function runChat(options: SharedCliOptions): Promise<void> {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  store.ensureLayout();

  const configName = options.config ?? "ds-chat";
  const initial = peekConfigRef(root, configName, overridesFromCli(options));
  resolveConfigRef(root, configName, overridesFromCli(options));

  let sessionId = options.session;
  const systemName = options.system ?? "default";
  if (sessionId === undefined) {
    const session = store.createSession({
      title: "chat",
      defaultConfig: configName,
      defaultSystem: systemName,
    });
    sessionId = session.id;
  } else if (!store.sessionExists(sessionId)) {
    throw new Error(`找不到会话：${sessionId}`);
  }

  const branchName = options.branch ?? "main";
  if (!store.branchExists(sessionId, branchName)) {
    throw new Error(`找不到分支：${branchName}。用 /branch 新建，或 js-llmlab branch create`);
  }

  const state: ReplState = {
    sessionId,
    branchName,
    configName,
    providerName: options.provider ?? initial.snapshot.provider,
    systemName,
    userName: options.user ?? null,
  };

  console.log(chalk.bold("js-llmlab chat"));
  console.log(chalk.dim(`session=${sessionId}  输入 /help 查看命令，/exit 退出`));
  console.log(helpText());

  const rl = createReadline();
  const onSigint = (): void => {
    console.log("");
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      const line = await rl.question(formatPrompt(state));
      const slash = await handleSlashCommand({ root, store, state, line });
      if (slash === "exit") {
        break;
      }
      if (slash === "handled") {
        continue;
      }
      const text = line.trim();
      if (text === "") {
        continue;
      }

      let userText: string;
      let config;
      let systemText: string;
      try {
        config = resolveConfigRef(root, state.configName, withProvider(options, state.providerName));
        systemText = resolveSystemText(root, state.systemName);
        userText = resolveUserText({
          root,
          userPreset: state.userName,
          input: line,
          mode: "chat",
        });
      } catch (error) {
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
        continue;
      }

      let reasoningStarted = false;
      let contentStarted = false;
      const node = await appendTurn({
        store,
        sessionId: state.sessionId,
        branchName: state.branchName,
        config,
        systemText,
        systemPreset: state.systemName,
        userPreset: state.userName,
        userText,
        completion: {
          stream: true,
          onReasoningDelta: (chunk) => {
            if (!reasoningStarted) {
              process.stdout.write(chalk.dim("[reasoning]\n"));
              reasoningStarted = true;
            }
            process.stdout.write(chalk.dim(chunk));
          },
          onDelta: (chunk) => {
            if (!contentStarted) {
              if (reasoningStarted) {
                process.stdout.write("\n");
              }
              process.stdout.write(chalk.green("assistant: "));
              contentStarted = true;
            }
            process.stdout.write(chunk);
          },
        },
      });
      process.stdout.write("\n");

      if (node.error !== null) {
        console.log(chalk.red(`请求失败：${node.error}`));
        continue;
      }

      const session = store.getSession(state.sessionId);
      if (session.title === "chat") {
        store.updateSession(state.sessionId, { title: truncateTitle(userText) });
      }
      console.log(chalk.dim(`node=${node.id} ${String(node.latencyMs)}ms`));
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}
