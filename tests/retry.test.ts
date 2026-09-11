import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareRetry } from "../src/commands/retry.ts";
import { runOnce } from "../src/commands/run.ts";
import { runCompareScore } from "../src/commands/score.ts";
import { withRetries } from "../src/lib/client.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, parseMaxRetries, parseTimeoutMs, peekConfigRef } from "../src/lib/config.ts";
import { parseSessionNode } from "../src/lib/parse.ts";
import { LabStore } from "../src/lib/store.ts";
import type { ResolvedConfig } from "../src/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

const silent = (): void => {};

function firstComparison(root: string): string {
  return readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
}

function baseConfig(maxRetries: number): ResolvedConfig {
  return {
    name: "x",
    provider: null,
    baseURL: "https://example.test/v1",
    model: "m",
    temperature: 0,
    maxTokens: 8,
    thinking: null,
    reasoningEffort: null,
    timeoutMs: 1000,
    maxRetries,
    apiKey: "sk-test-abc",
    apiKeyEnv: "TEST_KEY",
  };
}

test("withRetries：前 2 次抛错第 3 次成功；间隔可注入且指数退避", async () => {
  const fake = createFakeCompleter({ m: { failTimes: 2, text: "第三次成功" } });
  const waits: number[] = [];
  const retries: number[] = [];
  const complete = withRetries(fake.complete, {
    baseDelayMs: 10,
    sleep: async (ms) => {
      waits.push(ms);
    },
    onRetry: ({ attempt }) => retries.push(attempt),
  });
  const result = await complete(baseConfig(2), [{ role: "user", content: "q" }]);
  assert.equal(result.text, "第三次成功");
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(retries, [1, 2]);

  // maxRetries = 0：第一次失败直接抛
  const fake0 = createFakeCompleter({ m: { failTimes: 2, error: "boom" } });
  const complete0 = withRetries(fake0.complete, { baseDelayMs: 0 });
  await assert.rejects(complete0(baseConfig(0), [{ role: "user", content: "q" }]), /boom/);
  assert.equal(fake0.calls.length, 1);

  // 流式已经吐出内容后不再重试
  const streamedFake = createFakeCompleter({ m: { text: "abc" } });
  let calls = 0;
  const flaky = withRetries(
    async (config, messages, options) => {
      calls += 1;
      options?.onDelta?.("partial");
      if (calls === 1) {
        throw new Error("mid-stream");
      }
      return streamedFake.complete(config, messages, options);
    },
    { baseDelayMs: 0 },
  );
  await assert.rejects(flaky(baseConfig(2), [{ role: "user", content: "q" }], { stream: true, onDelta: () => {} }), /mid-stream/);
  assert.equal(calls, 1);
});

test("run：配置 maxRetries=2 时前两次失败仍落成功节点；--max-retries 0 时节点 error 有值", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "configs", "flaky.json"), { name: "flaky", provider: "test", model: "model-f", maxRetries: 2 });
  const fake = createFakeCompleter({ flaky: { failTimes: 2, text: "终于" } });
  const lines: string[] = [];

  await withEnvAsync(env, () =>
    runOnce(
      { config: "flaky", message: "q" },
      { root, complete: fake.complete, retryBaseDelayMs: 0, log: (l) => lines.push(l), error: silent },
    ),
  );
  assert.equal(fake.calls.length, 3);
  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const node = store.listNodes(sessionId)[0];
  assert.equal(node?.error, null);
  assert.equal(node?.messages.assistant, "终于");
  assert.equal(node?.config.maxRetries, 2);
  assert.equal(node?.config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(lines.filter((l) => l.includes("重试")).length, 2);

  const fake2 = createFakeCompleter({ flaky: { failTimes: 2, error: "boom" } });
  await withEnvAsync(env, () =>
    runOnce(
      { config: "flaky", message: "q", maxRetries: "0", timeoutMs: "1234" },
      { root, complete: fake2.complete, retryBaseDelayMs: 0, log: silent, error: silent },
    ),
  );
  assert.equal(fake2.calls.length, 1);
  const failed = store
    .listSessions()
    .flatMap((s) => store.listNodes(s.id))
    .find((n) => n.error !== null);
  assert.equal(failed?.error, "boom");
  assert.equal(failed?.config.maxRetries, 0);
  assert.equal(failed?.config.timeoutMs, 1234);
  process.exitCode = 0;
});

test("快照含 timeoutMs / maxRetries；旧节点缺字段解析为默认值；非法值报错", () => {
  const { root, env } = makeCommandLab();
  const snapshot = withEnvSync(env, () => peekConfigRef(root, "a").snapshot);
  assert.equal(snapshot.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(snapshot.maxRetries, 0); // 假实验室的 provider 显式设了 0

  const legacy = parseSessionNode({
    id: "n_old",
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    config: { name: "old", provider: null, baseURL: "https://x", model: "m", temperature: 1, maxTokens: 10, thinking: null, reasoningEffort: null },
    systemPreset: null,
    userPreset: null,
    messages: { system: "", user: "u", assistant: "a", reasoning: null },
    usage: null,
    latencyMs: 1,
    error: null,
  });
  assert.equal(legacy.config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(legacy.config.maxRetries, DEFAULT_MAX_RETRIES);

  assert.equal(parseTimeoutMs(undefined), undefined);
  assert.equal(parseTimeoutMs("5000"), 5000);
  assert.throws(() => parseTimeoutMs("0"), /timeoutMs/);
  assert.throws(() => parseTimeoutMs("1.5"), /timeoutMs/);
  assert.equal(parseMaxRetries("0"), 0);
  assert.throws(() => parseMaxRetries("-1"), /maxRetries/);
  assert.throws(() => parseMaxRetries("x"), /maxRetries/);
});

function withEnvSync<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("compare retry：只重跑失败路，其余 meta.json 不变，report 重渲染，scores.json 删除", async () => {
  const { root, env } = makeCommandLab();
  const gen = createFakeCompleter({ a: { text: "A 稿" }, b: { failTimes: 1, error: "网关 500" } });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "题目" }, { root, complete: gen.complete, log: silent }));
  const cmpId = firstComparison(root);
  const cmpDir = path.join(root, "data", "comparisons", cmpId);
  const store = new LabStore(root);
  assert.equal(store.readComparison(cmpId).variants[1]?.error, "网关 500");
  const aMetaBefore = readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8");
  const oldBNode = store.readComparison(cmpId).variants[1]?.nodeId ?? "";

  // 先打个分，补跑后应被删掉
  await withEnvAsync(env, () => runCompareScore(cmpId, {}, { root, log: silent }));
  assert.equal(existsSync(path.join(cmpDir, "scores.json")), true);

  const fix = createFakeCompleter({ b: { text: "B 稿（补跑）" } });
  const lines: string[] = [];
  await withEnvAsync(env, () =>
    runCompareRetry(cmpId, {}, { root, complete: fix.complete, retryBaseDelayMs: 0, log: (l) => lines.push(l) }),
  );

  assert.equal(fix.calls.length, 1);
  assert.equal(fix.calls[0]?.config.name, "b");
  assert.equal(fix.calls[0]?.messages.at(-1)?.content, "题目");
  assert.equal(fix.calls[0]?.messages[0]?.role, "system");
  assert.equal(readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8"), aMetaBefore);

  const after = store.readComparison(cmpId);
  const b = after.variants[1];
  assert.equal(b?.error, null);
  assert.equal(b?.assistant, "B 稿（补跑）");
  assert.notEqual(b?.nodeId, oldBNode);
  const sessionId = after.spec.sessionId ?? "";
  const newNode = store.getNode(sessionId, b?.nodeId ?? "");
  assert.equal(newNode.parentId, after.spec.fromNodeId);
  assert.equal(store.getBranch(sessionId, "b").head, newNode.id);
  // 旧的失败节点还在树里
  assert.equal(store.nodeExists(sessionId, oldBNode), true);

  const report = readFileSync(path.join(cmpDir, "report.md"), "utf8");
  assert.match(report, /B 稿（补跑）/);
  assert.doesNotMatch(report, /网关 500/);
  assert.doesNotMatch(report, /相似度/);
  assert.equal(existsSync(path.join(cmpDir, "scores.json")), false);
  assert.ok(lines.some((l) => l.includes("scores.json")));
});

test("compare retry：没有失败路时不发请求；--only 指定的路无论成败都重跑；未知名字报错", async () => {
  const { root, env } = makeCommandLab();
  const gen = createFakeCompleter({}, { text: "ok" });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "q" }, { root, complete: gen.complete, log: silent }));
  const cmpId = firstComparison(root);

  const none = createFakeCompleter({}, { text: "不该被调" });
  const lines: string[] = [];
  await withEnvAsync(env, () => runCompareRetry(cmpId, {}, { root, complete: none.complete, log: (l) => lines.push(l) }));
  assert.equal(none.calls.length, 0);
  assert.ok(lines.some((l) => l.includes("无需补跑")));

  const only = createFakeCompleter({}, { text: "重跑 a" });
  await withEnvAsync(env, () => runCompareRetry(cmpId, { only: "a" }, { root, complete: only.complete, log: silent }));
  assert.equal(only.calls.length, 1);
  assert.equal(only.calls[0]?.config.name, "a");
  const store = new LabStore(root);
  const { variants } = store.readComparison(cmpId);
  assert.equal(variants[0]?.assistant, "重跑 a");
  assert.equal(variants[1]?.assistant, "ok");

  await assert.rejects(
    withEnvAsync(env, () => runCompareRetry(cmpId, { only: "zzz" }, { root, complete: only.complete, log: silent })),
    /zzz/,
  );
  await assert.rejects(
    withEnvAsync(env, () => runCompareRetry("c_missing", {}, { root, complete: only.complete, log: silent })),
    /找不到对比/,
  );
});
