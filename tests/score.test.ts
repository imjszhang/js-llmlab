import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareScore } from "../src/commands/score.ts";
import { parseComparisonScores } from "../src/lib/parse.ts";
import { buildScores, scoreVariants } from "../src/lib/score.ts";
import { changeRatio, lcsLength, similarity } from "../src/lib/similarity.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter, throwingCompleter } from "./fake-completer.ts";
import { loadComparisonFixture } from "./fixtures.ts";
import { makeCommandLab, withEnvAsync, writeText } from "./helpers.ts";

const silent = (): void => {};

const UNRELATED =
  "今天下午的会议主要讨论了下一季度的预算分配方案。财务部门建议将市场推广费用削减百分之十五，转而投入到研发团队的扩张上。多位经理对此表示担忧，认为品牌曝光的减少会在半年内影响销售数据。最终决定成立一个专项小组，两周内给出详细的风险评估报告。";

test("similarity / changeRatio：相同为 1 / 0，无关 < 0.2，空串处理，确定性", () => {
  const { spec } = loadComparisonFixture("polish-8way");
  assert.equal(similarity("同一段话", "同一段话"), 1);
  assert.equal(changeRatio("同一段话", "同一段话"), 0);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
  assert.equal(lcsLength("ABCBDAB", "BDCABA"), 4);
  // 码点为单位：emoji 不会被拆成两半
  assert.equal(similarity("我😀你", "我😀你"), 1);
  assert.equal(changeRatio("a\r\nb", "a\nb"), 0);

  const unrelated = similarity(UNRELATED, spec.input);
  assert.ok(unrelated < 0.2, `无关文本相似度 ${String(unrelated)}`);
  assert.equal(similarity(UNRELATED, spec.input), unrelated);
});

test("fixture polish-8way：ds-v4-flash 几乎没改；打分确定；2000 字 × 8 路 < 1s", () => {
  const { spec, variants } = loadComparisonFixture("polish-8way");
  const once = scoreVariants({ spec, variants, referenceText: null });
  const twice = scoreVariants({ spec, variants, referenceText: null });
  assert.deepEqual(once, twice);
  const flash = once.find((s) => s.configName === "ds-v4-flash");
  assert.ok(flash);
  assert.ok(flash.changeRatio < 0.05, `flash 改动率 ${String(flash.changeRatio)}`);
  assert.equal(flash.barelyChanged, true);
  assert.equal(flash.similarity, null);
  assert.ok(once.filter((s) => s.barelyChanged).length === 1);
  for (const score of once) {
    assert.ok(score.changeRatio >= 0 && score.changeRatio <= 1);
  }

  // 2000 字候选 × 8 路，同时算相似度与改动率
  const long = variants.map((v) => ({
    ...v,
    assistant: (v.reasoning ?? v.assistant).repeat(4).slice(0, 2000),
  }));
  const reference = (variants[7]?.reasoning ?? "").slice(0, 2000);
  const longSpec = { ...spec, input: (variants[3]?.reasoning ?? "").slice(0, 2000) };
  const begin = Date.now();
  const scored = scoreVariants({ spec: longSpec, variants: long, referenceText: reference });
  const elapsed = Date.now() - begin;
  assert.equal(scored.length, 8);
  assert.ok(elapsed < 1000, `耗时 ${String(elapsed)}ms`);
});

test("buildScores 字段完整；不带 reference 时 similarity 为 null", () => {
  const { spec, variants } = loadComparisonFixture("polish-8way");
  const scores = buildScores({
    spec,
    variants,
    referenceText: null,
    referencePath: null,
    baselinePath: null,
    scoredAt: "2026-09-11T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(scores).sort(), ["baseline", "comparisonId", "reference", "scoredAt", "variants"]);
  assert.equal(scores.comparisonId, spec.id);
  assert.equal(scores.reference, null);
  assert.ok(scores.variants.every((v) => v.similarity === null));
  assert.deepEqual(Object.keys(scores.variants[0] ?? {}).sort(), [
    "barelyChanged",
    "changeRatio",
    "configName",
    "similarity",
  ]);
  const back = parseComparisonScores(JSON.parse(JSON.stringify(scores)));
  assert.deepEqual(back, scores);
});

test("compare score 命令：写 scores.json、报表追加两列、不发请求", async () => {
  const { root, env } = makeCommandLab();
  const input = "润色下面这段：昨天天气很好，我们去公园散步，看到很多人在放风筝。";
  const fake = createFakeCompleter({
    a: { text: input },
    b: { text: "昨儿天不错，我们去公园溜达，好多人放风筝。" },
  });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: input }, { root, complete: fake.complete, log: silent }),
  );
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  const cmpDir = path.join(root, "data", "comparisons", cmpId);

  const lines: string[] = [];
  await runCompareScore(cmpId, {}, { root, complete: throwingCompleter(), log: (l) => lines.push(l) });

  const store = new LabStore(root);
  const scores = store.readScores(cmpId);
  assert.ok(scores);
  assert.equal(scores.comparisonId, cmpId);
  assert.equal(scores.reference, null);
  assert.equal(scores.variants[0]?.changeRatio, 0);
  assert.equal(scores.variants[0]?.barelyChanged, true);
  assert.equal(scores.variants[0]?.similarity, null);
  assert.ok((scores.variants[1]?.changeRatio ?? 0) > 0.3);
  assert.equal(scores.variants[1]?.barelyChanged, false);

  const report = readFileSync(path.join(cmpDir, "report.md"), "utf8");
  assert.match(report, /\| 错误 \| 相似度 \| 改动率 \|/);
  assert.match(report, /\| a \| test \| model-a \| .* \| - \| 0\.0% \|/);
  assert.ok(lines.some((l) => l.includes("几乎没改") && l.includes("a")));

  // 带参考答案：相似度有值；重复打分结果一致（scoredAt 除外）
  const refPath = path.join(root, "data", "tmp", "gold.txt");
  writeText(refPath, "昨天天气不错，我们去公园散步，很多人在放风筝。");
  await runCompareScore(cmpId, { reference: refPath }, { root, complete: throwingCompleter(), log: silent });
  const withRef = store.readScores(cmpId);
  assert.ok(withRef);
  assert.equal(withRef.reference, refPath);
  assert.ok((withRef.variants[0]?.similarity ?? 0) > 0.7);
  assert.ok((withRef.variants[1]?.similarity ?? 0) > 0.3);
  const again = JSON.parse(readFileSync(path.join(cmpDir, "scores.json"), "utf8")) as { variants: unknown };
  assert.deepEqual(again.variants, withRef.variants);
  assert.equal(existsSync(path.join(cmpDir, "scores.json")), true);

  await assert.rejects(
    runCompareScore(cmpId, { reference: path.join(root, "nope.txt") }, { root, log: silent }),
    /找不到参考答案文件/,
  );
  await assert.rejects(runCompareScore("c_missing", {}, { root, log: silent }), /找不到对比/);
});
