import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderComparisonReport } from "../src/lib/render.ts";
import { fixturePath, loadComparisonFixture } from "./fixtures.ts";
import { assertMatchesGolden } from "./golden.ts";
import { withEnv } from "./helpers.ts";

test("fixture polish-8way：8 路、顺序与 spec 一致、无密钥痕迹", () => {
  const { spec, variants } = loadComparisonFixture("polish-8way");
  assert.equal(variants.length, 8);
  assert.deepEqual(
    variants.map((v) => v.configName),
    spec.configs,
  );
  assert.ok(variants.every((v) => v.error === null));
  assert.ok(variants.some((v) => v.reasoning !== null && v.reasoning !== ""));

  const raw = readFileSync(path.join(fixturePath("polish-8way"), "comparison.json"), "utf8");
  assert.doesNotMatch(raw, /sk-[A-Za-z0-9]/u);
  assert.doesNotMatch(raw, /Bearer\s/u);
  assert.doesNotMatch(raw, /apiKey/u);
});

test("对比报告渲染与黄金文件一致", () => {
  const { spec, variants } = loadComparisonFixture("polish-8way");
  assertMatchesGolden("polish-8way.report.md", renderComparisonReport(spec, variants));
});

test("assertMatchesGolden：缺文件给提示，UPDATE_GOLDEN=1 写文件，不一致时报错", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "js-llmlab-golden-"));
  withEnv({ UPDATE_GOLDEN: undefined }, () => {
    assert.throws(() => assertMatchesGolden("x.md", "a", dir), /UPDATE_GOLDEN=1/);
  });
  withEnv({ UPDATE_GOLDEN: "1" }, () => {
    assertMatchesGolden("x.md", "a", dir);
  });
  assert.equal(existsSync(path.join(dir, "x.md")), true);
  withEnv({ UPDATE_GOLDEN: undefined }, () => {
    assertMatchesGolden("x.md", "a", dir);
    assert.throws(() => assertMatchesGolden("x.md", "b", dir), /不一致/);
  });
});
