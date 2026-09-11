import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareRetry } from "../src/commands/retry.ts";
import { runOnce } from "../src/commands/run.ts";
import { runCompareScore } from "../src/commands/score.ts";
import { parseRepeat, stat, variantFromRuns, variantRuns } from "../src/lib/runs.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync } from "./helpers.ts";

const silent = (): void => {};

function comparisons(root: string): string[] {
  const dir = path.join(root, "data", "comparisons");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** 每次调用给不同的文本，模拟采样噪声。 */
function varying(texts: string[]): () => string {
  let i = 0;
  return () => {
    const text = texts[i % texts.length] ?? "";
    i += 1;
    return text;
  };
}

test("--repeat 3 两路 → 6 个节点、父节点全是 fromNodeId；汇总表每路一行、均值 (最小–最大)；run-<k>.md", async () => {
  const { root, env } = makeCommandLab();
  // 先造一个节点当 from
  const seed = createFakeCompleter({ a: { text: "起点" } });
  await withEnvAsync(env, () => runOnce({ config: "a", message: "开头" }, { root, complete: seed.complete, log: silent, error: silent }));
  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const fromNodeId = store.listNodes(sessionId)[0]?.id ?? "";

  const fake = createFakeCompleter({
    a: { text: varying(["甲", "甲乙", "甲乙丙"]), delayMs: 2 },
    b: { text: varying(["b1", "b2", "b3"]), reasoning: "想", delayMs: 2 },
  });
  const lines: string[] = [];
  await withEnvAsync(env, () =>
    runCompare(
      { configs: "a,b", message: "题", repeat: "3", session: sessionId, from: fromNodeId, concurrency: "2" },
      { root, complete: fake.complete, log: (l) => lines.push(l) },
    ),
  );

  assert.equal(fake.calls.length, 6);
  const nodes = store.listNodes(sessionId).filter((n) => n.id !== fromNodeId);
  assert.equal(nodes.length, 6);
  assert.ok(nodes.every((n) => n.parentId === fromNodeId), "每次采样都以 fromNodeId 为父，互不串联");
  // 每次请求的上下文都只有 起点 那一轮，不含其他采样
  assert.ok(fake.calls.every((c) => c.messages.filter((m) => m.role === "assistant").length === 1));

  const cmpId = comparisons(root)[0] ?? "";
  const cmpDir = path.join(root, "data", "comparisons", cmpId);
  const spec = JSON.parse(readFileSync(path.join(cmpDir, "spec.json"), "utf8")) as { repeat?: number };
  assert.equal(spec.repeat, 3);

  const report = readFileSync(path.join(cmpDir, "report.md"), "utf8");
  const tableRows = report.split("\n").filter((l) => l.startsWith("| a |") || l.startsWith("| b |"));
  assert.equal(tableRows.length, 2, "每路仍是一行");
  const rowA = tableRows[0] ?? "";
  // 耗时列：均值 (最小–最大)
  assert.match(rowA, /\| \d+\.\d \(\d+\.\d–\d+\.\d\) \|/u);
  // 成稿 tok（fake 的 token = 字数）：1、2、3 → 2 (1–3)
  assert.match(rowA, /\| 2 \(1–3\) \|/u);
  assert.match(report, /- repeat: 3/u);
  assert.match(report, /每路采样 3 次/u);
  // 正文是第 1 次
  assert.match(report, /## a\n\n甲\n/u);

  for (const k of [1, 2, 3]) {
    assert.equal(existsSync(path.join(cmpDir, "variants", "a", `run-${String(k)}.md`)), true);
  }
  assert.equal(existsSync(path.join(cmpDir, "variants", "a", "run-4.md")), false);
  assert.match(readFileSync(path.join(cmpDir, "variants", "a", "run-3.md"), "utf8"), /# Run 3\/3 a[\s\S]*甲乙丙/u);
  assert.match(readFileSync(path.join(cmpDir, "variants", "b", "run-2.md"), "utf8"), /## Reasoning[\s\S]*想[\s\S]*b2/u);
  assert.match(readFileSync(path.join(cmpDir, "variants", "a", "output.md"), "utf8"), /甲\n/u);
  assert.doesNotMatch(readFileSync(path.join(cmpDir, "variants", "a", "output.md"), "utf8"), /甲乙丙/u);

  const meta = JSON.parse(readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8")) as { runs?: unknown[] };
  assert.equal(meta.runs?.length, 3);

  const back = store.readComparison(cmpId);
  assert.deepEqual(back.variants[0]?.runs?.map((r) => r.assistant), ["甲", "甲乙", "甲乙丙"]);
  assert.equal(back.variants[0]?.assistant, "甲");
  assert.ok(lines.some((l) => l.includes("2 路 × 3 次 = 6 个任务")));
  assert.ok(lines.some((l) => l.includes("完成 a#3")));
});

test("--repeat 1 与不带参数落盘完全一致；非法值报错", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({}, { text: "同" });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "q" }, { root, complete: fake.complete, log: silent }));
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "q", repeat: "1" }, { root, complete: fake.complete, log: silent }));
  const [plain, one] = comparisons(root);
  const dirA = path.join(root, "data", "comparisons", plain ?? "");
  const dirB = path.join(root, "data", "comparisons", one ?? "");
  for (const rel of ["variants/a/meta.json", "variants/b/meta.json", "variants/a/output.md"]) {
    const a = readFileSync(path.join(dirA, rel), "utf8").replace(/n_[a-z0-9]+/gu, "N");
    const b = readFileSync(path.join(dirB, rel), "utf8").replace(/n_[a-z0-9]+/gu, "N");
    assert.equal(a, b, rel);
  }
  const specB = JSON.parse(readFileSync(path.join(dirB, "spec.json"), "utf8")) as Record<string, unknown>;
  assert.equal("repeat" in specB, false);
  assert.equal(readdirSync(path.join(dirB, "variants", "a")).some((f) => f.startsWith("run-")), false);

  assert.equal(parseRepeat(undefined), 1);
  assert.equal(parseRepeat("3"), 3);
  for (const bad of ["0", "-2", "1.5", "abc"]) {
    assert.throws(() => parseRepeat(bad), /--repeat/u, bad);
  }
  await assert.rejects(
    withEnvAsync(env, () => runCompare({ configs: "a,b", message: "q", repeat: "0" }, { root, complete: fake.complete, log: silent })),
    /--repeat/u,
  );
});

test("compare score 对每次成稿分别算并给均值；报表相似度列为 均值 (最小–最大)", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({
    a: { text: varying(["甲乙丙", "甲乙", "甲"]) },
    b: { text: "无关" },
  });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "题", repeat: "3", concurrency: "1" }, { root, complete: fake.complete, log: silent }),
  );
  const cmpId = comparisons(root)[0] ?? "";
  const refPath = path.join(root, "data", "tmp-ref.txt");
  writeFileSync(refPath, "甲乙丙", "utf8");
  const lines: string[] = [];
  await withEnvAsync(env, () => runCompareScore(cmpId, { reference: refPath }, { root, log: (l) => lines.push(l) }));

  const store = new LabStore(root);
  const scores = store.readScores(cmpId);
  const a = scores?.variants.find((v) => v.configName === "a");
  assert.ok(a);
  assert.equal(a.runs?.length, 3);
  // LCS 相似度：1、0.8、0.5 → 均值 0.7667
  const sims = a.runs?.map((r) => r.similarity ?? -1) ?? [];
  assert.ok(Math.abs((sims[0] ?? 0) - 1) < 1e-9);
  assert.ok(Math.abs((sims[1] ?? 0) - 0.8) < 1e-9);
  assert.ok(Math.abs((sims[2] ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((a.similarity ?? 0) - (1 + 0.8 + 0.5) / 3) < 1e-9);
  assert.ok(a.runs?.every((r) => typeof r.nodeId === "string"));
  const b = scores?.variants.find((v) => v.configName === "b");
  assert.equal(b?.runs?.length, 3); // 三次一样也逐次记录

  const report = readFileSync(path.join(root, "data", "comparisons", cmpId, "report.md"), "utf8");
  assert.match(report, /\| a \|[^\n]*\| 0\.767 \(0\.500–1\.000\) \|/u);
  assert.match(report, /\| b \|[^\n]*\| 0\.000 \(0\.000–0\.000\) \|/u);
});

test("compare retry 只补跑失败的那几次采样，其他采样与其他路不动", async () => {
  const { root, env } = makeCommandLab();
  // 并发 1 时任务顺序 a#1 a#2 a#3 b#1 b#2 b#3；b 的第 1 次调用失败
  const fake = createFakeCompleter({
    a: { text: varying(["a1", "a2", "a3"]) },
    b: { text: varying(["b-ok"]), failTimes: 1, error: "网关 502" },
  });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "题", repeat: "3", concurrency: "1" }, { root, complete: fake.complete, log: silent }),
  );
  const cmpId = comparisons(root)[0] ?? "";
  const cmpDir = path.join(root, "data", "comparisons", cmpId);
  const store = new LabStore(root);
  const before = store.readComparison(cmpId);
  assert.deepEqual(before.variants[1]?.runs?.map((r) => r.error), ["网关 502", null, null]);
  assert.equal(before.variants[1]?.error, "网关 502");
  const aMeta = readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8");
  const bRun2Node = before.variants[1]?.runs?.[1]?.nodeId;
  assert.match(readFileSync(path.join(cmpDir, "report.md"), "utf8"), /1\/3 失败：网关 502/u);

  const fix = createFakeCompleter({ b: { text: "b-fixed" } });
  const lines: string[] = [];
  await withEnvAsync(env, () => runCompareRetry(cmpId, {}, { root, complete: fix.complete, log: (l) => lines.push(l) }));

  assert.equal(fix.calls.length, 1);
  const after = store.readComparison(cmpId);
  assert.deepEqual(after.variants[1]?.runs?.map((r) => r.assistant), ["b-fixed", "b-ok", "b-ok"]);
  assert.equal(after.variants[1]?.runs?.[1]?.nodeId, bRun2Node, "没失败的采样不动");
  assert.equal(after.variants[1]?.error, null);
  assert.equal(after.variants[1]?.assistant, "b-fixed");
  assert.equal(readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8"), aMeta);
  assert.match(readFileSync(path.join(cmpDir, "variants", "b", "run-1.md"), "utf8"), /b-fixed/u);
  assert.match(readFileSync(path.join(cmpDir, "variants", "b", "output.md"), "utf8"), /b-fixed/u);
  assert.equal(readdirSync(path.join(cmpDir, "variants", "b")).filter((f) => f.startsWith("run-")).length, 3);
  assert.doesNotMatch(readFileSync(path.join(cmpDir, "report.md"), "utf8"), /网关 502/u);
  assert.ok(lines.some((l) => l.includes("补跑 1 个采样：b#1")));
});

test("runs 工具：variantRuns / variantFromRuns / stat", () => {
  const run = { nodeId: "n1", assistant: "x", reasoning: null, usage: null, latencyMs: 5, error: null, cost: null, requestId: null };
  const config = {
    name: "c", provider: null, baseURL: "https://x", model: "m", temperature: 1, maxTokens: 1,
    thinking: null, reasoningEffort: null, timeoutMs: 1, maxRetries: 0,
  };
  const single = variantFromRuns("c", config, [run]);
  assert.equal("runs" in single, false);
  assert.equal(variantRuns(single).length, 1);
  const multi = variantFromRuns("c", config, [run, { ...run, nodeId: "n2", latencyMs: 15 }]);
  assert.equal(multi.runs?.length, 2);
  assert.equal(multi.latencyMs, 5);
  assert.throws(() => variantFromRuns("c", config, []), /没有任何采样/u);
  assert.deepEqual(stat([1, null, 3, undefined]), { mean: 2, min: 1, max: 3, count: 2 });
  assert.equal(stat([null]), null);
});
