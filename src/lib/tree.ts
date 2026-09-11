import type { ChatMessage, ResolvedConfig, SessionNode } from "../types.ts";
import {
  formatError,
  runCompletion,
  type Completer,
  type CompletionOptions,
} from "./client.ts";
import { createId } from "./ids.ts";
import { toSnapshot } from "./config.ts";
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
  const complete = params.complete ?? runCompletion;
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

  let node: SessionNode;
  try {
    const result = await complete(config, messages, params.completion ?? {});
    node = {
      id: nodeId,
      parentId,
      createdAt,
      config: toSnapshot(config),
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
    };
  } catch (error) {
    node = {
      id: nodeId,
      parentId,
      createdAt,
      config: toSnapshot(config),
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
      error: formatError(error),
    };
  }
  store.writeNode(sessionId, node, writeOptions);
  store.writeBranch(sessionId, { ...branch, head: node.id });
  return node;
}
