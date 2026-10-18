import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runOnce } from "../src/commands/run.ts";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareRetry } from "../src/commands/retry.ts";
import { LabStore } from "../src/lib/store.ts";
import { isRecord } from "../src/lib/parse.ts";
import { createFakeCompleter, throwingCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

const quiet = { log: () => {}, error: () => {} };

test("图片与工具完整消息落盘后可手动续接，普通后续轮次不丢历史字段", async () => {
  const { root, env } = makeCommandLab();
  const store = new LabStore(root);
  const toolFile = path.join(root, "tools.json");
  writeJson(toolFile, [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }]);
  const image = path.join(root, "image.png");
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRGkAAAAASUVORK5CYII=", "base64"));
  const assistant = { role: "assistant", content: null, reasoning_content: "需要查找", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] };
  const first = createFakeCompleter({ a: { text: "", assistantMessage: assistant, responseModel: "test-version-1017" } });
  await withEnvAsync(env, async () => {
    await runOnce({ config: "a", message: "分析这张图", image: [image], tools: toolFile }, { root, complete: first.complete, ...quiet });
    const session = store.listSessions()[0];
    assert.ok(session);
    const head = store.getBranch(session.id, "main").head;
    assert.ok(head);
    const node = store.getNode(session.id, head);
    assert.equal(node.responseModel, "test-version-1017");
    assert.deepEqual(node.messages.apiMessages?.at(-1), assistant);
    const user = node.messages.apiMessages?.find((message) => message.role === "user");
    assert.ok(Array.isArray(user?.content));
    const transcript = path.join(root, "messages.json");
    writeJson(transcript, [...(node.messages.apiMessages ?? []), { role: "tool", tool_call_id: "call_1", content: "查询结果" }]);
    const next = createFakeCompleter({ a: { text: "分析结果", reasoning: "综合信息" } });
    await runOnce({ config: "a", session: session.id, messages: transcript, tools: toolFile }, { root, complete: next.complete, ...quiet });
    const calls = next.calls[0]?.options.request?.messages;
    assert.ok(Array.isArray(calls));
    assert.deepEqual(calls.at(-1), { role: "tool", tool_call_id: "call_1", content: "查询结果" });
    const third = createFakeCompleter();
    await runOnce({ config: "a", session: session.id, message: "继续解释" }, { root, complete: third.complete, ...quiet });
    const history = third.calls[0]?.options.request?.messages;
    assert.ok(Array.isArray(history));
    assert.ok(history.some((message: Record<string, unknown>) => message.tool_call_id === "call_1"));
    assert.deepEqual(history.at(-1), { role: "user", content: "继续解释" });
  });
});

test("高级 compare 补跑复用已解析附件与工具快照，不重新读取输入文件", async () => {
  const { root, env } = makeCommandLab();
  const toolFile = path.join(root, "tools.json");
  writeJson(toolFile, [{ type: "function", function: { name: "lookup" } }]);
  const fake = createFakeCompleter({ a: { failTimes: 1 } });
  await withEnvAsync(env, async () => {
    await runCompare({ configs: "a,b", message: "识别", image: ["https://example.test/image.png"], tools: toolFile }, { root, complete: fake.complete, ...quiet });
    const store = new LabStore(root);
    const comparisonId = readdirSync(path.join(root, "data", "comparisons"))[0];
    assert.ok(comparisonId);
    const original = store.readComparison(comparisonId).spec.request;
    assert.ok(original);
    writeJson(toolFile, [{ changed: true }]);
    const retry = createFakeCompleter();
    await runCompareRetry(comparisonId, {}, { root, complete: retry.complete, ...quiet });
    assert.equal(retry.calls.length, 1);
    assert.deepEqual(retry.calls[0]?.options.request, original);
    const restored = store.readComparison(comparisonId);
    assert.equal(restored.variants[0]?.error, null);
    assert.deepEqual(restored.spec.request, original);
  });
});

test("高级 dry-run 不需要 key、不落盘；配置覆盖失败在创建会话之前", async () => {
  const { root, env } = makeCommandLab();
  const out: string[] = [];
  await withEnvAsync({ ...env, TEST_KEY: undefined }, async () => {
    await runOnce({ config: "a", message: "返回键值", jsonOutput: true, fileId: ["file-api-abc"], dryRun: true }, { root, complete: throwingCompleter(), log: (line) => out.push(line), error: quiet.error });
  });
  assert.equal(existsSync(path.join(root, "data", "sessions")), false);
  const result: unknown = JSON.parse(out.join(""));
  assert.ok(isRecord(result) && Array.isArray(result.variants));
  assert.deepEqual(result.variants[0].request.response_format, { type: "json_object" });
  const requestFile = path.join(root, "request.json");
  writeJson(requestFile, { model: "wrong-model" });
  await withEnvAsync(env, async () => {
    await assert.rejects(runOnce({ config: "a", message: "x", request: requestFile }, { root, complete: throwingCompleter(), ...quiet }), /不允许覆盖 model/u);
  });
  assert.equal(existsSync(path.join(root, "data", "sessions")), false);
});

test("高级 assistant 的嵌套字段回显 key 时，节点、turn、raw 和普通 stdout 全部脱敏", async () => {
  const { root, env } = makeCommandLab();
  const key = "sk-test-abc";
  const fake = createFakeCompleter({ a: {
    text: `answer ${key}`,
    assistantMessage: { role: "assistant", content: `answer ${key}`, reasoning_content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: JSON.stringify({ text: key }) } }] },
  } });
  const output: string[] = [];
  await withEnvAsync(env, async () => {
    await runOnce({ config: "a", message: "hello", jsonOutput: true }, { root, complete: fake.complete, log: (line) => output.push(line), error: quiet.error });
  });
  assert.equal(output.join(""), "answer ***");
  const store = new LabStore(root);
  const session = store.listSessions()[0];
  assert.ok(session);
  for (const dir of ["nodes", "turns"]) {
    const folder = path.join(root, "data", "sessions", session.id, dir);
    for (const file of readdirSync(folder)) assert.ok(!readFileSync(path.join(folder, file), "utf8").includes(key), file);
  }
});
