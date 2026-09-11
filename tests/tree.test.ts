import assert from "node:assert/strict";
import { test } from "node:test";
import { LabStore } from "../src/lib/store.ts";
import { ancestorChain, buildApiMessages, forkBranch } from "../src/lib/tree.ts";
import type { SessionNode } from "../src/types.ts";
import { makeLabRoot } from "./helpers.ts";

function node(
  id: string,
  parentId: string | null,
  user: string,
  assistant: string,
): SessionNode {
  return {
    id,
    parentId,
    createdAt: `2026-09-11T00:00:0${id.slice(-1)}.000Z`,
    config: {
      name: "default",
      provider: null,
      baseURL: "https://example.test",
      model: "demo",
      temperature: 1,
      maxTokens: 16,
      thinking: null,
      reasoningEffort: null,
    },
    systemPreset: "default",
    userPreset: null,
    messages: { system: "old-system", user, assistant, reasoning: null },
    usage: null,
    latencyMs: 1,
    error: null,
    cost: null,
  };
}

test("祖先链与 API 消息使用当前 system，不改写历史 system", () => {
  const store = new LabStore(makeLabRoot());
  const session = store.createSession({
    title: "tree",
    defaultConfig: "default",
    defaultSystem: "default",
  });
  store.writeNode(session.id, node("n_1", null, "u1", "a1"));
  store.writeNode(session.id, node("n_2", "n_1", "u2", "a2"));

  const chain = ancestorChain(store, session.id, "n_2");
  assert.deepEqual(chain.map((item) => item.id), ["n_1", "n_2"]);

  const messages = buildApiMessages("new-system", chain, "u3");
  assert.deepEqual(messages, [
    { role: "system", content: "new-system" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
  ]);
});

test("fork 共享节点，不复制文件", () => {
  const store = new LabStore(makeLabRoot());
  const session = store.createSession({
    title: "fork",
    defaultConfig: "default",
    defaultSystem: null,
  });
  store.writeNode(session.id, node("n_1", null, "u1", "a1"));
  store.writeBranch(session.id, { name: "main", head: "n_1", createdFrom: null });

  const alt = forkBranch(store, session.id, "alt", "n_1");
  assert.equal(alt.head, "n_1");
  assert.equal(store.listNodes(session.id).length, 1);
  assert.equal(store.getBranch(session.id, "main").head, "n_1");
  assert.equal(store.getBranch(session.id, "alt").head, "n_1");
  assert.throws(() => forkBranch(store, session.id, "alt", "n_1"), /已存在/);
});
