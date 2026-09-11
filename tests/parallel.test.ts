import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { mapWithConcurrency, parseConcurrency } from "../src/lib/concurrency.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter, type FakeReply } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

const silent = (): void => {};

function fourWayLab(): ReturnType<typeof makeCommandLab> {
  const lab = makeCommandLab();
  writeJson(path.join(lab.root, "configs", "c.json"), { name: "c", provider: "test", model: "model-c" });
  writeJson(path.join(lab.root, "configs", "d.json"), { name: "d", provider: "test", model: "model-d" });
  return lab;
}

async function timedCompare(
  rules: Record<string, FakeReply>,
  concurrency: string,
): Promise<{ root: string; elapsedMs: number; calls: ReturnType<typeof createFakeCompleter>["calls"] }> {
  const { root, env } = fourWayLab();
  const fake = createFakeCompleter(rules);
  const begin = Date.now();
  await withEnvAsync(env, () =>
    runCompare(
      { configs: "a,b,c,d", message: "q", concurrency },
      { root, complete: fake.complete, log: silent },
    ),
  );
  return { root, elapsedMs: Date.now() - begin, calls: fake.calls };
}

const hundred: Record<string, FakeReply> = {
  a: { delayMs: 100 },
  b: { delayMs: 100 },
  c: { delayMs: 100 },
  d: { delayMs: 100 },
};

test("4 路各 100ms，--concurrency 4 总时长 < 250ms", async () => {
  const { elapsedMs } = await timedCompare(hundred, "4");
  assert.ok(elapsedMs < 250, `实际 ${String(elapsedMs)}ms`);
});

test("4 路各 100ms，--concurrency 1 总时长 > 400ms", async () => {
  const { elapsedMs } = await timedCompare(hundred, "1");
  assert.ok(elapsedMs > 400, `实际 ${String(elapsedMs)}ms`);
});

test("完成顺序打乱时报表与 spec 仍按输入顺序，所有落盘文件可重新解析", async () => {
  const { root, calls } = await timedCompare(
    {
      a: { delayMs: 120, text: "A" },
      b: { delayMs: 10, text: "B" },
      c: { delayMs: 60, text: "C", reasoning: "c 想" },
      d: { delayMs: 30, text: "D" },
    },
    "4",
  );
  assert.equal(calls.length, 4);

  const store = new LabStore(root);
  const session = store.listSessions()[0];
  assert.ok(session);
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  const { spec, variants } = store.readComparison(cmpId);
  assert.deepEqual(spec.configs, ["a", "b", "c", "d"]);
  assert.deepEqual(
    variants.map((v) => v.configName),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    variants.map((v) => v.assistant),
    ["A", "B", "C", "D"],
  );

  // 全部文件能被 LabStore 重新解析
  assert.equal(store.listNodes(session.id).length, 4);
  const branches = store.listBranches(session.id);
  assert.deepEqual(
    branches.map((b) => b.name),
    ["a", "b", "c", "d", "main"],
  );
  for (const variant of variants) {
    assert.equal(store.getBranch(session.id, variant.configName).head, variant.nodeId);
  }
  assert.ok(store.getSession(session.id).updatedAt >= session.createdAt);
});

test("一路失败不影响其他路", async () => {
  const { root } = await timedCompare(
    {
      a: { delayMs: 5 },
      b: { delayMs: 5, failTimes: 1, error: "网关 500" },
      c: { delayMs: 5 },
      d: { delayMs: 5 },
    },
    "4",
  );
  const store = new LabStore(root);
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  const { variants } = store.readComparison(cmpId);
  assert.deepEqual(
    variants.map((v) => v.error),
    [null, "网关 500", null, null],
  );
  assert.ok(variants.filter((v) => v.error === null).every((v) => v.assistant === "echo: q"));
});

test("--concurrency 非法值报错，缺省 3", () => {
  assert.equal(parseConcurrency(undefined), 3);
  assert.equal(parseConcurrency("8"), 8);
  assert.throws(() => parseConcurrency("0"), /--concurrency/);
  assert.throws(() => parseConcurrency("2.5"), /--concurrency/);
  assert.throws(() => parseConcurrency("abc"), /--concurrency/);
  assert.throws(() => parseConcurrency("-1"), /--concurrency/);
});

test("mapWithConcurrency 按输入顺序返回，且同时在跑的不超过上限", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (ms, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
    running -= 1;
    return `${String(index)}:${String(ms)}`;
  });
  assert.deepEqual(results, ["0:30", "1:5", "2:20", "3:1", "4:10"]);
  assert.equal(peak, 2);
});
