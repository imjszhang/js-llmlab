import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareRetry } from "../src/commands/retry.ts";
import { runOnce } from "../src/commands/run.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

const silent = (): void => {};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWTYAAAAASUVORK5CYII=", "base64");

test("高级图片请求失败后续接：保留失败轮的真实图片输入，不追加空 assistant", async () => {
  const { root, env } = makeCommandLab();
  const image = path.join(root, "image.png");
  writeFileSync(image, png);
  const fake = createFakeCompleter({ a: { failTimes: 1, error: "temporary", text: "retry answer" } });
  const store = new LabStore(root);
  const before = process.exitCode;
  try {
    await withEnvAsync(env, () => runOnce({ config: "a", message: "看图", image: [image] }, {
      root, complete: fake.complete, log: silent, error: silent,
    }));
    const session = store.listSessions()[0];
    assert.ok(session);
    const failed = store.listNodes(session.id)[0];
    assert.ok(failed);
    assert.equal(failed.error, "temporary");
    assert.deepEqual(failed.messages.apiMessages, fake.calls[0]?.options.request?.messages);
    assert.equal(failed.messages.apiMessages?.at(-1)?.role, "user");
    rmSync(image);
    await withEnvAsync(env, () => runOnce({ config: "a", session: session.id, message: "继续分析" }, {
      root, complete: fake.complete, log: silent, error: silent,
    }));
    const request = fake.calls[1]?.options.request;
    assert.ok(request);
    const serialized = JSON.stringify(request.messages);
    assert.match(serialized, /data:image\/png;base64/);
    assert.match(serialized, /看图/);
    assert.match(serialized, /继续分析/);
    assert.doesNotMatch(serialized, /"role":"assistant"/);
    const final = store.getNode(session.id, store.getBranch(session.id, "main").head ?? "");
    assert.equal(final.messages.assistant, "retry answer");
    assert.match(JSON.stringify(final.messages.apiMessages), /data:image\/png;base64/);
  } finally {
    process.exitCode = before;
  }
});

test("compare retry：原本地图片已删除时使用已冻结的请求快照", async () => {
  const { root, env } = makeCommandLab();
  const image = path.join(root, "image.png");
  writeFileSync(image, png);
  const original = createFakeCompleter({ a: { text: "A" }, b: { failTimes: 1, error: "temporary" } });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "描述", image: [image] }, {
    root, complete: original.complete, log: silent,
  }));
  const store = new LabStore(root);
  const comparison = store.listComparisons().entries[0];
  assert.ok(comparison);
  const stored = store.readComparison(comparison.id);
  const originalRequest = structuredClone(stored.spec.request);
  assert.match(JSON.stringify(originalRequest), /data:image\/png;base64/);
  rmSync(image);
  const retry = createFakeCompleter({}, { text: "B repaired" });
  await withEnvAsync(env, () => runCompareRetry(comparison.id, {}, {
    root, complete: retry.complete, log: silent,
  }));
  assert.equal(retry.calls.length, 1);
  assert.equal(retry.calls[0]?.config.name, "b");
  assert.deepEqual(retry.calls[0]?.options.request, originalRequest);
  assert.equal(store.readComparison(comparison.id).variants[1]?.assistant, "B repaired");
});

test("旧文本会话首次添加 tools：回传祖先节点中已有的 reasoning_content", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "test.json"), {
    name: "test", baseURL: "https://api.deepseek.com", apiKeyEnv: "TEST_KEY",
    model: "deepseek-flash", maxRetries: 0, thinking: "enabled",
  });
  const tools = path.join(root, "tools.json");
  writeJson(tools, [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }]);
  const fake = createFakeCompleter({}, { text: "answer", reasoning: "historical reasoning" });
  await withEnvAsync(env, () => runOnce({ config: "a", message: "first" }, {
    root, complete: fake.complete, log: silent, error: silent,
  }));
  const store = new LabStore(root);
  const session = store.listSessions()[0];
  assert.ok(session);
  const legacy = store.listNodes(session.id)[0];
  assert.equal(legacy?.messages.apiMessages, undefined);
  await withEnvAsync(env, () => runOnce({ config: "a", session: session.id, message: "second", tools }, {
    root, complete: fake.complete, log: silent, error: silent,
  }));
  const request = fake.calls[1]?.options.request;
  assert.ok(request);
  assert.match(JSON.stringify(request.messages), /"reasoning_content":"historical reasoning"/);
  const last = store.getNode(session.id, store.getBranch(session.id, "main").head ?? "");
  assert.equal(last.error, null);
  assert.ok(last.messages.apiMessages);
});

test("prefix 成功后续接：历史包含前缀和追加文本，stdout 与原始响应保持追加文本", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({}, { text: "const answer = 42;" });
  const out: string[] = [];
  await withEnvAsync(env, () => runOnce({ config: "a", message: "code", prefix: "```ts\n" }, {
    root, complete: fake.complete, log: (text) => out.push(text), error: silent,
  }));
  const store = new LabStore(root);
  const session = store.listSessions()[0];
  assert.ok(session);
  const node = store.listNodes(session.id)[0];
  assert.ok(node);
  assert.equal(node.messages.assistant, "const answer = 42;");
  assert.deepEqual(out, ["const answer = 42;"]);
  assert.equal(node.messages.apiMessages?.at(-1)?.content, "```ts\nconst answer = 42;");
  assert.equal(node.messages.apiMessages?.at(-1)?.prefix, undefined);
  const raw = JSON.stringify(store.readNodeRaw(session.id, node.id));
  assert.match(raw, /"prefix":true/);
  assert.match(raw, /"content":"const answer = 42;"/);
  await withEnvAsync(env, () => runOnce({ config: "a", session: session.id, message: "explain" }, {
    root, complete: fake.complete, log: silent, error: silent,
  }));
  const sent = JSON.stringify(fake.calls[1]?.options.request?.messages);
  assert.match(sent, /```ts\\nconst answer = 42;/);
  assert.doesNotMatch(sent, /"prefix":true/);
});

test("prefix 失败后续接：去掉未完成的 prefix 消息，raw 保留原请求", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ a: { failTimes: 1, error: "temporary", text: "next" } });
  const before = process.exitCode;
  try {
    await withEnvAsync(env, () => runOnce({ config: "a", message: "code", prefix: "unfinished prefix" }, {
      root, complete: fake.complete, log: silent, error: silent,
    }));
    const store = new LabStore(root);
    const session = store.listSessions()[0];
    assert.ok(session);
    const failed = store.listNodes(session.id)[0];
    assert.ok(failed);
    assert.equal(failed.messages.apiMessages?.at(-1)?.role, "user");
    assert.doesNotMatch(JSON.stringify(failed.messages.apiMessages), /unfinished prefix|"prefix":true/);
    assert.match(JSON.stringify(store.readNodeRaw(session.id, failed.id)), /unfinished prefix/);
    await withEnvAsync(env, () => runOnce({ config: "a", session: session.id, message: "continue" }, {
      root, complete: fake.complete, log: silent, error: silent,
    }));
    assert.doesNotMatch(JSON.stringify(fake.calls[1]?.options.request?.messages), /unfinished prefix|"prefix":true/);
  } finally {
    process.exitCode = before;
  }
});
