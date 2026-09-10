import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LabStore } from "../src/lib/store.ts";
import type { SessionNode } from "../src/types.ts";
import { makeLabRoot } from "./helpers.ts";

function sampleNode(id: string, parentId: string | null): SessionNode {
  return {
    id,
    parentId,
    createdAt: "2026-09-11T00:00:00.000Z",
    config: {
      name: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-chat",
      temperature: 0.3,
      maxTokens: 4096,
    },
    systemPreset: "default",
    userPreset: null,
    messages: {
      system: "sys",
      user: "hello",
      assistant: "world",
    },
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    latencyMs: 12,
    error: null,
  };
}

test("会话、节点、分支读写", () => {
  const root = makeLabRoot();
  const store = new LabStore(root);
  const session = store.createSession({
    title: "demo",
    defaultConfig: "default",
    defaultSystem: "default",
  });
  assert.equal(store.sessionExists(session.id), true);
  assert.equal(store.getBranch(session.id, "main").head, null);

  const node = sampleNode("n_aaa", null);
  store.writeNode(session.id, node);
  store.writeBranch(session.id, { name: "main", head: node.id, createdFrom: null });

  assert.deepEqual(store.getNode(session.id, "n_aaa").messages, node.messages);
  assert.equal(store.getBranch(session.id, "main").head, "n_aaa");
  assert.equal(store.listSessions()[0]?.id, session.id);

  const turnPath = path.join(root, "data", "sessions", session.id, "turns", "n_aaa.md");
  assert.equal(existsSync(turnPath), true);
  const turn = readFileSync(turnPath, "utf8");
  assert.match(turn, /hello/);
  assert.match(turn, /world/);
  assert.doesNotMatch(turn, /sk-|apiKey|secret/u);
});
