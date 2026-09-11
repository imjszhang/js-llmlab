import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runCompareScore } from "../src/commands/score.ts";
import { runCompareLs, runCompareShow, runNodeShow } from "../src/commands/show.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, makeLabRoot, withEnvAsync } from "./helpers.ts";

const silent = (): void => {};

function collect(): { lines: string[]; errors: string[]; log: (l: string) => void; error: (l: string) => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (l) => lines.push(l), error: (l) => errors.push(l) };
}

test("compare ls：空目录友好提示，不报错", () => {
  const root = makeLabRoot();
  const out = collect();
  runCompareLs({ root, log: out.log, error: out.error });
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0] ?? "", /还没有对比/u);
  assert.deepEqual(out.errors, []);
});

test("compare ls：倒序、坏 spec 跳过并警告、输入摘要 40 字、scores 标记", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({}, { text: "ok" });
  const longInput = "这是一段很长的输入".repeat(10);
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "第一次" }, { root, complete: fake.complete, log: silent }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: longInput, repeat: "2" }, { root, complete: fake.complete, log: silent }));
  const ids = readdirSync(path.join(root, "data", "comparisons")).sort();
  const store = new LabStore(root);
  const byCreated = ids
    .map((id) => store.readComparison(id).spec)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const [older, newer] = byCreated;
  await withEnvAsync(env, () => runCompareScore(older?.id ?? "", {}, { root, log: silent }));

  // 一个没有 spec.json 的目录，一个 spec.json 是坏 JSON 的目录
  mkdirSync(path.join(root, "data", "comparisons", "c_nospec"));
  mkdirSync(path.join(root, "data", "comparisons", "c_badjson"));
  writeFileSync(path.join(root, "data", "comparisons", "c_badjson", "spec.json"), "{ not json", "utf8");

  const out = collect();
  runCompareLs({ root, log: out.log, error: out.error });
  const text = out.lines.join("\n");
  const rows = text.split("\n").slice(1);
  assert.equal(rows.length, 2, "坏目录不该出现在列表里");
  assert.ok(rows[0]?.startsWith(newer?.id ?? "?"), "最新的在前");
  assert.ok(rows[1]?.startsWith(older?.id ?? "?"));
  assert.match(rows[0] ?? "", /2×2/u);
  assert.match(rows[1] ?? "", /有/u);
  assert.doesNotMatch(rows[0] ?? "", /有/u);
  assert.equal(text.includes(longInput), false, "输入应截断");
  assert.match(rows[0] ?? "", /这是一段很长的输入[^\n]*…/u);
  assert.equal(out.errors.length, 2);
  assert.ok(out.errors.some((l) => l.includes("c_nospec") && l.includes("spec.json")));
  assert.ok(out.errors.some((l) => l.includes("c_badjson")));
});

test("compare show：汇总表与 report.md 里的完全一致；找不到时错误含期望路径", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ a: { text: "甲", reasoning: "想" }, b: { failTimes: 1, error: "boom" } });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "题" }, { root, complete: fake.complete, log: silent }));
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  const refPath = path.join(root, "data", "ref.txt");
  writeFileSync(refPath, "甲乙", "utf8");
  await withEnvAsync(env, () => runCompareScore(cmpId, { reference: refPath }, { root, log: silent }));

  const out = collect();
  runCompareShow(cmpId, { root, log: out.log });
  const shown = out.lines.join("\n");
  const report = readFileSync(path.join(root, "data", "comparisons", cmpId, "report.md"), "utf8");
  const tableOf = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("|"));
  assert.deepEqual(tableOf(shown), tableOf(report));
  assert.equal(tableOf(shown).length, 4);
  assert.match(shown, /相似度/u);
  assert.ok(shown.includes(path.join(root, "data", "comparisons", cmpId)));

  assert.throws(
    () => runCompareShow("c_missing", { root, log: silent }),
    (err: unknown) => err instanceof Error && err.message.includes(path.join("data", "comparisons", "c_missing", "spec.json")),
  );
});

test("node show：默认打 turn md，--json 可被 JSON.parse；找不到时错误含期望路径", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ a: { text: "成稿甲", requestId: "req-1" } });
  await withEnvAsync(env, () => runCompare({ configs: "a,b", message: "问题" }, { root, complete: fake.complete, log: silent }));
  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const node = store.listNodes(sessionId).find((n) => n.messages.assistant === "成稿甲");
  assert.ok(node);

  const md = collect();
  runNodeShow(sessionId, node.id, {}, { root, log: md.log });
  const text = md.lines.join("\n");
  assert.match(text, new RegExp(`^# Turn ${node.id}`, "u"));
  assert.match(text, /问题/u);
  assert.match(text, /成稿甲/u);
  assert.match(text, /- requestId: req-1/u);

  const json = collect();
  runNodeShow(sessionId, node.id, { json: true }, { root, log: json.log });
  const parsed = JSON.parse(json.lines.join("\n")) as { id: string; messages: { assistant: string } };
  assert.equal(parsed.id, node.id);
  assert.equal(parsed.messages.assistant, "成稿甲");
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(node)));

  assert.throws(
    () => runNodeShow(sessionId, "n_missing", {}, { root, log: silent }),
    (err: unknown) => err instanceof Error && err.message.includes(path.join("nodes", "n_missing.json")),
  );
  assert.throws(
    () => runNodeShow("s_missing", "n_x", {}, { root, log: silent }),
    (err: unknown) => err instanceof Error && err.message.includes("s_missing"),
  );
});
