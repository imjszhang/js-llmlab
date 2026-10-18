import type { ChatMessage, RawCapture, ResolvedConfig, SessionNode } from "../types.ts";
import {
  buildChatRequest,
  formatError,
  redactSecrets,
  requestIdFromError,
  runCompletion,
  serializeError,
  withRetries,
  type Completer,
  type CompletionOptions,
} from "./client.ts";

/** 不经命令层注入时（chat）用的缺省 completer：真实网关 + 按配置重试。 */
const defaultCompleter: Completer = withRetries(runCompletion);
import { createId } from "./ids.ts";
import { toSnapshot } from "./config.ts";
import { computeCost } from "./cost.ts";
import { parseSessionNode } from "./parse.ts";
import type { LabStore } from "./store.ts";

export function ancestorChain(
  store: LabStore,
  sessionId: string,
  nodeId: string | null,
): SessionNode[] {
  if (nodeId === null) {
    return [];
  }
  const chain: SessionNode[] = [];
  let current: string | null = nodeId;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) {
      throw new Error(`会话树存在环：${current}`);
    }
    seen.add(current);
    const node = store.getNode(sessionId, current);
    chain.unshift(node);
    current = node.parentId;
  }
  return chain;
}

export function buildApiMessages(
  systemText: string,
  ancestors: SessionNode[],
  currentUser: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (systemText.trim() !== "") {
    messages.push({ role: "system", content: systemText });
  }
  for (const node of ancestors) {
    if (node.messages.user !== "") {
      messages.push({ role: "user", content: node.messages.user });
    }
    if (node.messages.assistant !== "") {
      messages.push({ role: "assistant", content: node.messages.assistant });
    }
  }
  messages.push({ role: "user", content: currentUser });
  return messages;
}

/** 从最新的完整协议记录恢复图片、工具调用和 reasoning；system 始终采用当前值。 */
export function buildProtocolMessages(
  systemText: string,
  ancestors: SessionNode[],
  currentUser: string,
  force = false,
): Record<string, unknown>[] | undefined {
  let history: Record<string, unknown>[] | undefined = force ? [] : undefined;
  for (const node of ancestors) {
    if (node.messages.apiMessages !== undefined) {
      history = node.messages.apiMessages.filter((message) => message.role !== "system");
    } else if (history !== undefined) {
      if (node.messages.user !== "") history.push({ role: "user", content: node.messages.user });
      if (node.messages.assistant !== "") {
        const assistant: Record<string, unknown> = { role: "assistant", content: node.messages.assistant };
        if (node.messages.reasoning !== null) assistant.reasoning_content = node.messages.reasoning;
        history.push(assistant);
      }
    }
  }
  if (history === undefined) return undefined;
  const messages: Record<string, unknown>[] = [];
  if (systemText.trim() !== "") messages.push({ role: "system", content: systemText });
  messages.push(...history, { role: "user", content: currentUser });
  return messages;
}

export function forkBranch(
  store: LabStore,
  sessionId: string,
  name: string,
  fromNodeId: string | null,
): { name: string; head: string | null; createdFrom: string | null } {
  if (store.branchExists(sessionId, name)) {
    throw new Error(`分支已存在：${name}`);
  }
  if (fromNodeId !== null) {
    store.getNode(sessionId, fromNodeId);
  }
  const branch = {
    name,
    head: fromNodeId,
    createdFrom: fromNodeId,
  };
  store.writeBranch(sessionId, branch);
  return branch;
}

export async function appendTurn(params: {
  store: LabStore;
  sessionId: string;
  branchName: string;
  parentId?: string | null;
  config: ResolvedConfig;
  systemText: string;
  systemPreset: string | null;
  userPreset: string | null;
  userText: string;
  completion?: CompletionOptions;
  /** 缺省用真实网关；测试注入假实现。 */
  complete?: Completer;
  /** 并发多路时传 false，由调用方在整轮结束后刷一次会话时间。 */
  touchSession?: boolean;
}): Promise<SessionNode> {
  const {
    store,
    sessionId,
    branchName,
    config,
    systemText,
    systemPreset,
    userPreset,
    userText,
  } = params;
  const complete = params.complete ?? defaultCompleter;
  const branch = store.getBranch(sessionId, branchName);
  const parentId = params.parentId !== undefined ? params.parentId : branch.head;
  if (parentId !== null) {
    store.getNode(sessionId, parentId);
  }
  const ancestors = ancestorChain(store, sessionId, parentId);
  const messages = buildApiMessages(systemText, ancestors, userText);
  const nodeId = createId("n");
  const createdAt = new Date().toISOString();
  const writeOptions = { touchSession: params.touchSession !== false };

  const completion: CompletionOptions = { ...params.completion };
  const protocolMessages = buildProtocolMessages(systemText, ancestors, userText);
  if (protocolMessages !== undefined && completion.request?.messages === undefined) {
    completion.request = { ...completion.request, messages: protocolMessages };
  }
  const snapshot = toSnapshot(config);

  let node: SessionNode;
  let raw: RawCapture;
  try {
    const result = await complete(config, messages, completion);
    node = {
      id: nodeId,
      parentId,
      createdAt,
      config: snapshot,
      systemPreset,
      userPreset,
      messages: {
        system: systemText,
        user: userText,
        assistant: result.text,
        reasoning: result.reasoning,
      },
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: null,
      cost: computeCost(result.usage, config.pricing),
      requestId: result.requestId,
    };
    if (result.responseModel !== undefined) node.responseModel = result.responseModel;
    if (completion.request?.messages !== undefined || result.assistantMessage !== undefined) {
      const sent = completion.request?.messages;
      const history: Record<string, unknown>[] = Array.isArray(sent)
        ? sent.filter((message): message is Record<string, unknown> =>
            typeof message === "object" && message !== null && !Array.isArray(message))
        : messages.map((message) => ({ ...message }));
      // API 仅返回 prefix 后新生成的部分；历史需还原完整 assistant，raw 与成稿仍保留原响应。
      const prefix = history.at(-1)?.prefix === true ? history.pop() : undefined;
      const assistant: Record<string, unknown> = structuredClone(result.assistantMessage ?? {
        role: "assistant", content: result.text, reasoning_content: result.reasoning,
      });
      if (typeof prefix?.content === "string" && (typeof assistant.content === "string" || assistant.content === null)) {
        assistant.content = prefix.content + (assistant.content ?? "");
      }
      node.messages.apiMessages = [...history, assistant];
    }
    raw = result.raw ?? {
      request: buildChatRequest(snapshot, messages, completion.stream === true, completion.request),
      response: null,
      chunkCount: null,
      requestId: result.requestId,
      systemFingerprint: null,
      headers: {},
      error: null,
    };
  } catch (error) {
    const requestId = requestIdFromError(error);
    node = {
      id: nodeId,
      parentId,
      createdAt,
      config: snapshot,
      systemPreset,
      userPreset,
      messages: {
        system: systemText,
        user: userText,
        assistant: "",
        reasoning: null,
      },
      usage: null,
      latencyMs: 0,
      // 网关的报错文本偶尔会回显请求头，密钥一律打码再落盘。
      error: redactSecrets(formatError(error), [config.apiKey]),
      cost: null,
      requestId,
    };
    const sent = completion.request?.messages;
    if (Array.isArray(sent)) {
      // 失败仍保留真实输入；下一轮续接不能把图片或工具结果降成 userText。
      node.messages.apiMessages = sent
        .filter((message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null && !Array.isArray(message))
        .map((message) => structuredClone(message));
      // 未成功的 prefix 没有产生回答，后续 user 不能排在 prefix:true 后；原请求仍在 raw 中。
      if (node.messages.apiMessages.at(-1)?.prefix === true) node.messages.apiMessages.pop();
    }
    raw = {
      request: buildChatRequest(snapshot, messages, completion.stream === true, completion.request),
      response: null,
      chunkCount: null,
      requestId,
      systemFingerprint: null,
      headers: {},
      error: serializeError(error),
    };
  }
  // 高级协议消息可能回显密钥，和 raw 一样在任何节点/turn 写盘前整体打码。
  const safeNode: unknown = JSON.parse(redactSecrets(JSON.stringify(node), [config.apiKey]));
  node = parseSessionNode(safeNode);
  store.writeNode(sessionId, node, writeOptions);
  store.writeNodeRaw(sessionId, nodeId, raw, [config.apiKey]);
  store.writeBranch(sessionId, { ...branch, head: node.id });
  return node;
}
