import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const SRC = path.resolve(import.meta.dirname, "..", "src");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

test("类型绕过只允许出现在 client.ts 的一个适配函数里（#14）", () => {
  const hits: string[] = [];
  for (const file of listTsFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of [/as never/gu, /as unknown as/gu]) {
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        hits.push(`${path.relative(SRC, file)}:${String(line)} ${match[0]}`);
      }
    }
  }
  assert.deepEqual(hits.length, 1, `类型绕过应只有 1 处，实际：\n${hits.join("\n")}`);
  assert.match(hits[0] ?? "", /^lib\/client\.ts:\d+ as never$/u);

  // 且这一处要带解释性注释（JSDoc 里出现「类型绕过」）。
  const client = readFileSync(path.join(SRC, "lib", "client.ts"), "utf8");
  const index = client.indexOf("as never");
  const before = client.slice(Math.max(0, index - 1200), index);
  assert.match(before, /类型绕过/u);
});
