import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { diffSnapshots, materializeFixture, snapshotFixture, snapshotWorkspace } from "../src/lib/bench/workspace.ts";
import type { BenchTask } from "../src/lib/bench/types.ts";
import { makeLabRoot, writeText } from "./helpers.ts";

function setup(): { root: string; task: BenchTask } {
  const root = makeLabRoot();
  writeText(path.join(root, "tasks/fixtures/source/b.txt"), "second");
  writeText(path.join(root, "tasks/fixtures/source/a.txt"), "first");
  return { root, task: { name: "fix", prompt: "fix", fixture: "tasks/fixtures/source", timeoutMs: 1000, checks: [] } };
}

test("fixture hash is deterministic over sorted paths, content and mode while omitting private/build files", () => {
  const { root, task } = setup();
  for (const name of [".env", ".env.local", "a/.env.production", ".git/config", "node_modules/pkg/index.js", "a/archives/old.txt"]) writeText(path.join(root, task.fixture ?? "", name), "private");
  writeText(path.join(root, task.fixture ?? "", ".env.example"), "KEY=");
  const first = snapshotFixture(root, task);
  assert.deepEqual(first.files.map((file) => file.path), [".env.example", "a.txt", "b.txt"]);
  assert.deepEqual(snapshotFixture(root, task), first);
  chmodSync(path.join(root, task.fixture ?? "", "a.txt"), 0o755);
  assert.notEqual(snapshotFixture(root, task).hash, first.hash);
  writeText(path.join(root, task.fixture ?? "", "a.txt"), "changed");
  assert.notEqual(snapshotFixture(root, task).hash, first.hash);
});

test("sampling copies are independent and file changes include deletes and mode modifications", () => {
  const { root, task } = setup();
  const source = snapshotFixture(root, task);
  const one = path.join(root, "data/bench/one");
  const two = path.join(root, "data/bench/two");
  materializeFixture(root, task, one);
  materializeFixture(root, task, two);
  assert.deepEqual(snapshotWorkspace(one), source);
  writeFileSync(path.join(one, "a.txt"), "updated");
  rmSync(path.join(one, "b.txt"));
  writeFileSync(path.join(one, "c.txt"), "new");
  assert.equal(readFileSync(path.join(two, "a.txt"), "utf8"), "first");
  assert.equal(readFileSync(path.join(root, task.fixture ?? "", "a.txt"), "utf8"), "first");
  assert.deepEqual(diffSnapshots(source, snapshotWorkspace(one)).map(({ path, kind }) => ({ path, kind })), [
    { path: "a.txt", kind: "modified" }, { path: "b.txt", kind: "deleted" }, { path: "c.txt", kind: "added" },
  ]);
  assert.deepEqual(diffSnapshots(source, snapshotWorkspace(two)), []);
  chmodSync(path.join(two, "a.txt"), 0o700);
  assert.equal(diffSnapshots(source, snapshotWorkspace(two))[0]?.kind, "modified");
});

test("fixture materialization rejects source overlap, nonempty workspace and symlinks", () => {
  const { root, task } = setup();
  const source = path.join(root, task.fixture ?? "");
  for (const workspace of [root, source, path.join(source, "child"), path.dirname(source)]) {
    assert.throws(() => materializeFixture(root, task, workspace), /不能|重叠/u);
  }
  const occupied = path.join(root, "data/occupied");
  writeText(path.join(occupied, "old.txt"), "old");
  assert.throws(() => materializeFixture(root, task, occupied), /空目录/u);
  symlinkSync(path.join(source, "a.txt"), path.join(source, "link.txt"));
  assert.throws(() => snapshotFixture(root, task), /符号链接/u);
  assert.throws(() => materializeFixture(root, task, path.join(root, "data/fresh")), /符号链接/u);
  rmSync(path.join(source, "link.txt"));
  symlinkSync(source, path.join(root, "data/link"));
  assert.throws(() => materializeFixture(root, task, path.join(root, "data/link")), /符号链接/u);
});

test("task without fixture gets an independent empty workspace", () => {
  const root = makeLabRoot();
  const task: BenchTask = { name: "simple", prompt: "hello", timeoutMs: 1000, checks: [] };
  const workspace = path.join(root, "data/empty");
  mkdirSync(workspace);
  materializeFixture(root, task, workspace);
  assert.deepEqual(snapshotWorkspace(workspace), snapshotFixture(root, task));
});
