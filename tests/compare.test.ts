import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runOnce } from "../src/commands/run.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync } from "./helpers.ts";

const silent = (): void => {};

function comparisonDirs(root: string): string[] {
  const dir = path.join(root, "data", "comparisons");
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("compare 注入假 completer：两路各一个节点、一个分支，report 含两路", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({
    a: { text: "答案 A", reasoning: "想了想" },
    b: { text: "答案 B" },
  });

  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "同一道题" }, { root, complete: fake.complete, log: silent }),
  );

  const store = new LabStore(root);
  const sessions = store.listSessions();
  assert.equal(sessions.length, 1);
  const sessionId = sessions[0]?.id ?? "";
  const nodes = store.listNodes(sessionId);
  assert.equal(nodes.length, 2);
  assert.deepEqual(
    nodes.map((n) => n.messages.assistant).sort(),
    ["答案 A", "答案 B"],
  );
  const branchNames = store.listBranches(sessionId).map((b) => b.name);
  assert.ok(branchNames.includes("a"));
  assert.ok(branchNames.includes("b"));

  const dirs = comparisonDirs(root);
  assert.equal(dirs.length, 1);
  const report = readFileSync(path.join(root, "data", "comparisons", dirs[0] ?? "", "report.md"), "utf8");
  assert.match(report, /## a/);
  assert.match(report, /## b/);
  assert.match(report, /答案 A/);
  assert.match(report, /答案 B/);

  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]?.messages.at(-1)?.content, "同一道题");
  assert.equal(fake.calls[0]?.messages[0]?.role, "system");
});

test("compare 某路抛错：节点 error 非空、assistant 为空、分支 head 前进", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({
    a: { text: "ok" },
    b: { failTimes: 1, error: "boom" },
  });

  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "x" }, { root, complete: fake.complete, log: silent }),
  );

  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const failed = store.listNodes(sessionId).find((n) => n.error !== null);
  assert.ok(failed);
  assert.equal(failed.error, "boom");
  assert.equal(failed.messages.assistant, "");
  assert.equal(store.getBranch(sessionId, "b").head, failed.id);

  const dirs = comparisonDirs(root);
  const report = readFileSync(path.join(root, "data", "comparisons", dirs[0] ?? "", "report.md"), "utf8");
  assert.match(report, /error: boom/);
});

test("run 注入假 completer：落盘一个节点并打印成稿", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ a: { text: "只此一句" } });
  const lines: string[] = [];

  await withEnvAsync(env, () =>
    runOnce(
      { config: "a", message: "你好" },
      { root, complete: fake.complete, log: (line) => lines.push(line), error: silent },
    ),
  );

  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const nodes = store.listNodes(sessionId);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.messages.assistant, "只此一句");
  assert.ok(lines.includes("只此一句"));
  assert.equal(store.getBranch(sessionId, "main").head, nodes[0]?.id);
});
