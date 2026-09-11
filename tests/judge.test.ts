import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareScore } from "../src/commands/score.ts";
import { parseJudgeReply, renderJudgePrompt } from "../src/lib/judge.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson, writeText } from "./helpers.ts";

const silent = (): void => {};

/** 建一个带两路结果与 judge 配置的对比，返回 root / env / c_id。 */
async function labWithComparison(): Promise<{ root: string; env: Record<string, string | undefined>; cmpId: string }> {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "configs", "judge-cfg.json"), {
    name: "judge-cfg",
    provider: "test",
    model: "model-judge",
    thinking: "enabled",
    reasoningEffort: "high",
  });
  writeText(
    path.join(root, "prompts", "judge", "default.md"),
    "打分。\n\n## 原文\n{{input}}\n\n## 参考\n{{reference}}\n\n## 候选\n{{candidate}}\n",
  );
  const fake = createFakeCompleter({ a: { text: "A 稿" }, b: { text: "B 稿" } });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "题目" }, { root, complete: fake.complete, log: silent }),
  );
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  return { root, env, cmpId };
}

test("parseJudgeReply：容忍围栏与废话，拒绝越界与非 JSON", () => {
  assert.deepEqual(parseJudgeReply('{"score":7,"reason":"ok"}'), { score: 7, reason: "ok" });
  assert.deepEqual(parseJudgeReply('```json\n{"score": 8.5, "reason": "好"}\n```'), { score: 8.5, reason: "好" });
  assert.deepEqual(parseJudgeReply('结论如下：{"score":"6","reason":"还行"} 谢谢'), { score: 6, reason: "还行" });
  assert.equal(parseJudgeReply('{"score":3}').reason, "");
  assert.throws(() => parseJudgeReply("我觉得挺好"), /没有 JSON/);
  assert.throws(() => parseJudgeReply('{"score":11,"reason":"x"}'), /0–10/);
  assert.throws(() => parseJudgeReply('{"score":"高","reason":"x"}'), /0–10/);
  assert.throws(() => parseJudgeReply("{bad json}"), /解析失败/);
  // 真实案例（ds-v4-pro-reason 在线裁判）：reason 收尾用了中文右引号，JSON 非法，兜底仍能拿到分数与理由
  assert.deepEqual(
    parseJudgeReply('{"score": 7.5, "reason": "基本忠实，说人话，但相较参考答案精炼不足，未紧盯“谁说了算、做到哪停、算谁的”这一核心取舍，显得散。”}'),
    { score: 7.5, reason: "基本忠实，说人话，但相较参考答案精炼不足，未紧盯“谁说了算、做到哪停、算谁的”这一核心取舍，显得散。" },
  );
  assert.throws(() => parseJudgeReply('{"score": 12, "reason": "x”}'), /0–10/);
});

test("renderJudgePrompt：三个变量都替换，没参考答案时给占位", () => {
  const out = renderJudgePrompt("I={{input}} R={{reference}} C={{candidate}}", {
    input: "原",
    reference: null,
    candidate: "候",
  });
  assert.equal(out, "I=原 R=（未提供参考答案） C=候");
});

test("--judge：假裁判返回 {score:7}，每路 judge.score = 7，落到 judge: 会话", async () => {
  const { root, env, cmpId } = await labWithComparison();
  const judge = createFakeCompleter({ "judge-cfg": { text: '{"score":7,"reason":"ok"}', reasoning: "评审思路" } });
  const lines: string[] = [];
  await withEnvAsync(env, () =>
    runCompareScore(cmpId, { judge: "judge-cfg" }, { root, complete: judge.complete, log: (l) => lines.push(l) }),
  );

  const store = new LabStore(root);
  const scores = store.readScores(cmpId);
  assert.ok(scores);
  assert.ok(scores.judge);
  assert.equal(scores.judge.config.name, "judge-cfg");
  assert.equal(scores.judge.config.thinking, "enabled");
  assert.equal(scores.judge.rubric, "default");
  assert.equal("apiKey" in scores.judge.config, false);
  assert.equal(scores.variants.length, 2);
  for (const variant of scores.variants) {
    assert.equal(variant.judge?.score, 7);
    assert.equal(variant.judge?.reason, "ok");
    assert.equal(variant.judge?.error, null);
    assert.ok(variant.judge?.usage);
    assert.ok(variant.judge?.nodeId);
  }

  // 裁判会话：标题含 judge:，两路各一个节点，思维链可查
  const judgeSession = store.listSessions().find((s) => s.title.includes("judge:"));
  assert.ok(judgeSession);
  assert.equal(judgeSession.id, scores.judge.sessionId);
  assert.equal(judgeSession.title, `judge: ${cmpId}`);
  const nodes = store.listNodes(judgeSession.id);
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((n) => n.messages.reasoning === "评审思路"));
  assert.deepEqual(
    store.listBranches(judgeSession.id).map((b) => b.name),
    ["judge-a", "judge-b", "main"],
  );

  // 裁判收到的 messages 含候选文本与原文
  assert.equal(judge.calls.length, 2);
  const users = judge.calls.map((c) => c.messages.at(-1)?.content ?? "");
  assert.ok(users.some((u) => u.includes("A 稿")));
  assert.ok(users.some((u) => u.includes("B 稿")));
  assert.ok(users.every((u) => u.includes("题目")));
  assert.ok(users.every((u) => u.includes("（未提供参考答案）")));
  assert.ok(judge.calls.every((c) => c.config.name === "judge-cfg"));

  // 报表有裁判列与理由
  const report = readFileSync(path.join(root, "data", "comparisons", cmpId, "report.md"), "utf8");
  assert.match(report, /\| 相似度 \| 改动率 \| 裁判 \|/);
  assert.match(report, /\| a \| model-a \| .* \| 7 \|/);
  assert.match(report, /### 裁判理由/);
  assert.match(report, /- a：7 — ok/);
  assert.ok(lines.some((l) => l.includes("裁判 judge-cfg")));
});

test("--judge：一路返回非 JSON 时该路 judge.error 有值，其他路正常；带 --reference 时提示词含参考答案", async () => {
  const { root, env, cmpId } = await labWithComparison();
  const refPath = path.join(root, "data", "tmp", "gold.txt");
  writeText(refPath, "标准答案文本");
  const judge = createFakeCompleter({
    "judge-cfg": {
      text: (messages) => ((messages.at(-1)?.content ?? "").includes("B 稿") ? "我觉得还行" : '{"score":9,"reason":"好"}'),
    },
  });
  await withEnvAsync(env, () =>
    runCompareScore(
      cmpId,
      { judge: "judge-cfg", reference: refPath, concurrency: "2" },
      { root, complete: judge.complete, log: silent },
    ),
  );
  const scores = new LabStore(root).readScores(cmpId);
  assert.ok(scores);
  const a = scores.variants.find((v) => v.configName === "a");
  const b = scores.variants.find((v) => v.configName === "b");
  assert.equal(a?.judge?.score, 9);
  assert.equal(a?.judge?.error, null);
  assert.equal(b?.judge?.score, null);
  assert.match(b?.judge?.error ?? "", /没有 JSON/);
  assert.ok(b?.judge?.nodeId, "解析失败也保留节点，便于回看");
  assert.ok(judge.calls.every((c) => (c.messages.at(-1)?.content ?? "").includes("标准答案文本")));
  assert.ok((a?.similarity ?? null) !== null);

  const report = readFileSync(path.join(root, "data", "comparisons", cmpId, "report.md"), "utf8");
  assert.match(report, /\| b \| model-b \| .* \| 错误 \|/);
});

test("--judge：rubric 不存在时报错并列出可用名字；候选路失败时不评审", async () => {
  const { root, env, cmpId } = await labWithComparison();
  writeText(path.join(root, "prompts", "judge", "strict.md"), "{{candidate}}");
  const judge = createFakeCompleter({ "judge-cfg": { text: '{"score":5,"reason":"x"}' } });
  await withEnvAsync(env, () =>
    assert.rejects(
      runCompareScore(cmpId, { judge: "judge-cfg", rubric: "nope" }, { root, complete: judge.complete, log: silent }),
      /找不到裁判 rubric：nope.*default, strict/u,
    ),
  );
  assert.equal(judge.calls.length, 0, "rubric 不存在时不应发请求");

  // 一路候选失败的对比：失败路不评审
  const { root: root2, env: env2 } = makeCommandLab();
  writeJson(path.join(root2, "configs", "judge-cfg.json"), { name: "judge-cfg", provider: "test", model: "model-judge" });
  writeText(path.join(root2, "prompts", "judge", "default.md"), "{{candidate}}");
  const gen = createFakeCompleter({ a: { text: "A" }, b: { failTimes: 1, error: "boom" } });
  await withEnvAsync(env2, () => runCompare({ configs: "a,b", message: "q" }, { root: root2, complete: gen.complete, log: silent }));
  const cmpId2 = readdirSync(path.join(root2, "data", "comparisons"))[0] ?? "";
  const judge2 = createFakeCompleter({ "judge-cfg": { text: '{"score":5,"reason":"x"}' } });
  await withEnvAsync(env2, () =>
    runCompareScore(cmpId2, { judge: "judge-cfg" }, { root: root2, complete: judge2.complete, log: silent }),
  );
  assert.equal(judge2.calls.length, 1);
  const scores2 = new LabStore(root2).readScores(cmpId2);
  assert.equal(scores2?.variants.find((v) => v.configName === "a")?.judge?.score, 5);
  assert.match(scores2?.variants.find((v) => v.configName === "b")?.judge?.error ?? "", /候选路失败/);
});
