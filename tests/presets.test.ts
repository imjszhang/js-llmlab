import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  applyUserPreset,
  listPresets,
  loadPreset,
  resolveUserText,
} from "../src/lib/presets.ts";
import { makeLabRoot, writeText } from "./helpers.ts";

test("加载 system/user 预设", () => {
  const root = makeLabRoot();
  writeText(path.join(root, "prompts", "system", "default.md"), "你是助手。\n");
  writeText(path.join(root, "prompts", "user", "hello.md"), "复述：\n\n{{input}}\n");
  assert.deepEqual(listPresets(root, "system"), ["default"]);
  assert.deepEqual(listPresets(root, "user"), ["hello"]);
  assert.equal(loadPreset(root, "system", "default"), "你是助手。");
});

test("{{input}} 替换；run 无占位符用预设全文；chat 拼接", () => {
  assert.equal(applyUserPreset("A {{input}} B", "x", "run"), "A x B");
  assert.equal(applyUserPreset("固定题", "被忽略", "run"), "固定题");
  assert.equal(applyUserPreset("前缀", "补充", "chat"), "前缀\n\n补充");
  assert.equal(applyUserPreset("前缀", "", "chat"), "前缀");
});

test("resolveUserText 在缺输入时抛错", () => {
  const root = makeLabRoot();
  writeText(path.join(root, "prompts", "user", "hello.md"), "请回答：{{input}}");
  writeText(path.join(root, "prompts", "user", "fixed.md"), "只问这一句");

  assert.equal(
    resolveUserText({ root, userPreset: "hello", input: "天气", mode: "run" }),
    "请回答：天气",
  );
  assert.equal(
    resolveUserText({ root, userPreset: "fixed", input: "ignored", mode: "run" }),
    "只问这一句",
  );
  assert.throws(
    () => resolveUserText({ root, userPreset: "hello", input: "", mode: "run" }),
    /{{input}}/,
  );
  assert.throws(
    () => resolveUserText({ root, userPreset: null, input: "", mode: "run" }),
    /需要 --message/,
  );
});
