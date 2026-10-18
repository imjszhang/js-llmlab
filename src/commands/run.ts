import chalk from "chalk";
import type { DryRunEntry, SharedCliOptions } from "../types.ts";
import { buildChatRequest, type CompletionOptions } from "../lib/client.ts";
import { prepareChatRequest } from "../lib/chat-options.ts";
import { loadEnv, overridesFromCli, peekConfigRef, resolveConfigRef } from "../lib/config.ts";
import { readMessageInput, resolveSystemText, resolveUserText } from "../lib/presets.ts";
import { renderDryRun, truncateTitle } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { ancestorChain, appendTurn, buildApiMessages, buildProtocolMessages } from "../lib/tree.ts";
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
  const userText = input.trim() === "" && options.messages !== undefined && userName === null ? "" : resolveUserText({
    root,
    userPreset: userName,
    input,
    mode: "run",
  });
  const systemText = resolveSystemText(root, systemName);
  const branchName = options.branch ?? "main";

  const existingSession = options.session;
  const parentId = existingSession !== undefined && store.sessionExists(existingSession) && store.branchExists(existingSession, branchName)
    ? store.getBranch(existingSession, branchName).head : null;
  const ancestors = existingSession !== undefined && parentId !== null ? ancestorChain(store, existingSession, parentId) : [];
  const messages = buildApiMessages(systemText, ancestors, userText);
  const request = await prepareChatRequest(messages, options, buildProtocolMessages(systemText, ancestors, userText,
    options.tools !== undefined || options.request !== undefined));

  if (options.dryRun === true) {
    // 不要 key、不建会话、不写 data/。已有会话时只读祖先链。
    const peeked = peekConfigRef(root, configName, overrides);
    const entry: DryRunEntry = {
      ref: configName,
      config: peeked.snapshot,
      apiKeyEnv: peeked.apiKeyEnv,
      apiKeyPresent: peeked.apiKeyPresent,
      messages,
      request: buildChatRequest(peeked.snapshot, messages, options.stream === true, request),
    };
    log(renderDryRun([entry]));
    return;
  }

  const config = resolveConfigRef(root, configName, overrides);
  // 先验证协议请求，避免参数错误留下空会话。
  buildChatRequest(config, messages, options.stream === true, request);
  store.ensureLayout();

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
  if (Object.keys(request).length > 0) completion.request = request;

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
  if (node.messages.apiMessages?.at(-1)?.tool_calls !== undefined) {
    error(chalk.dim(`模型请求调用工具；完整 assistant 消息已写入节点 ${node.id} 的 messages.apiMessages（用 --messages 续接结果）。`));
  }
  error(chalk.dim(`session=${sessionId} branch=${branchName} node=${node.id} ${String(node.latencyMs)}ms`));
}
