import chalk from "chalk";
import type { DryRunEntry, SharedCliOptions } from "../types.ts";
import { buildChatRequest, type CompletionOptions } from "../lib/client.ts";
import { loadEnv, overridesFromCli, peekConfigRef, resolveConfigRef } from "../lib/config.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { renderDryRun, truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { ancestorChain, appendTurn, buildApiMessages } from "../lib/tree.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

/**
 * 非流式等着网关时，TTY 上每隔 intervalMs 往 stderr 打一行「等待中… Ns」。
 * 返回停止函数；非 TTY 什么都不做（管道里不出现进度）。
 */
function startProgress(params: {
  enabled: boolean;
  intervalMs: number;
  label: string;
  error: (line: string) => void;
}): () => void {
  if (!params.enabled) {
    return () => {};
  }
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    params.error(chalk.dim(`等待 ${params.label}… ${String(elapsed)}s`));
  }, params.intervalMs);
  return () => {
    clearInterval(timer);
  };
}

export async function runOnce(options: SharedCliOptions, deps?: CommandDeps): Promise<void> {
  const { root, complete, log, write, error, writeErr, isTTY, progressIntervalMs } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);

  const configName = options.config ?? "ds-chat";
  const overrides = overridesFromCli(options);
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
  const branchName = options.branch ?? "main";

  if (options.dryRun === true) {
    // 不要 key、不建会话、不写 data/。已有会话时只读祖先链。
    const peeked = peekConfigRef(root, configName, overrides);
    const sessionId = options.session;
    const parentId =
      sessionId !== undefined && store.sessionExists(sessionId) && store.branchExists(sessionId, branchName)
        ? store.getBranch(sessionId, branchName).head
        : null;
    const ancestors = sessionId !== undefined && parentId !== null ? ancestorChain(store, sessionId, parentId) : [];
    const messages = buildApiMessages(systemText, ancestors, userText);
    const entry: DryRunEntry = {
      ref: configName,
      config: peeked.snapshot,
      apiKeyEnv: peeked.apiKeyEnv,
      apiKeyPresent: peeked.apiKeyPresent,
      messages,
      request: buildChatRequest(peeked.snapshot, messages, false),
    };
    log(renderDryRun([entry]));
    return;
  }

  store.ensureLayout();
  const config = resolveConfigRef(root, configName, overrides);

  let sessionId = options.session;
  if (sessionId === undefined) {
    const session = store.createSession({
      title: truncateTitle(userText),
      defaultConfig: configName,
      defaultSystem: systemName,
    });
    sessionId = session.id;
    error(chalk.dim(`新建会话 ${sessionId}`));
  } else if (!store.sessionExists(sessionId)) {
    throw new Error(`找不到会话：${sessionId}`);
  }

  if (!store.branchExists(sessionId, branchName)) {
    throw new Error(`找不到分支：${branchName}`);
  }

  const stream = options.stream === true;
  const showReasoning = stream && options.hideReasoning !== true;
  let reasoningStarted = false;
  let contentStarted = false;
  const completion: CompletionOptions = stream
    ? {
        stream: true,
        // 思维链走 stderr（变暗），成稿走 stdout：管道里只拿到成稿。
        onReasoningDelta: (chunk) => {
          if (!showReasoning) {
            return;
          }
          if (!reasoningStarted) {
            error(chalk.dim("[reasoning]"));
            reasoningStarted = true;
          }
          writeErr(chalk.dim(chunk));
        },
        onDelta: (chunk) => {
          if (!contentStarted) {
            if (reasoningStarted) {
              writeErr("\n");
            }
            contentStarted = true;
          }
          write(chunk);
        },
      }
    : {};

  const stopProgress = startProgress({
    enabled: !stream && isTTY,
    intervalMs: progressIntervalMs,
    label: `${config.name} → ${config.model}`,
    error,
  });
  let node;
  try {
    node = await appendTurn({
      store,
      sessionId,
      branchName,
      config,
      systemText,
      systemPreset: systemName,
      userPreset: userName,
      userText,
      completion,
      complete,
    });
  } finally {
    stopProgress();
  }

  if (node.error !== null) {
    if (contentStarted) {
      write("\n");
    }
    error(chalk.red(`请求失败：${node.error}`));
    error(chalk.dim(`已落盘 ${node.id}`));
    process.exitCode = 1;
    return;
  }

  if (stream) {
    // 增量已经打过；补一个换行结束这一行。没有任何增量（空成稿）就不补。
    if (contentStarted) {
      write("\n");
    }
  } else {
    log(node.messages.assistant);
  }
  error(chalk.dim(`session=${sessionId} branch=${branchName} node=${node.id} ${String(node.latencyMs)}ms`));
}
