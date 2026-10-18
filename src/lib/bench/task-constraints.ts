import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { RUNTIME_DIRECTORY_NAMES } from "./runtime-directories.ts";
import type { TaskCheck, TaskManifest } from "./types.ts";

function ignored(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "archives" || name === ".env"
    || (name.startsWith(".env.") && name !== ".env.example");
}

function filesIn(directory: string, prefix = ""): Array<{ path: string; sha256: string; mode: number }> {
  return readdirSync(directory).sort().flatMap((name) => {
    if (ignored(name)) return [];
    const absolute = path.join(directory, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`不允许符号链接：${relative}`);
    if (stat.isDirectory()) return filesIn(absolute, relative);
    if (!stat.isFile()) throw new Error(`不支持的文件类型：${relative}`);
    return [{ path: relative, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"), mode: stat.mode & 0o777 }];
  });
}

function matches(file: string, pattern: string): boolean {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

/** Emit an independent checker: no candidate-controlled module is imported into this process. */
export function freezeManifestCheck(fixtureDirectory: string | undefined, manifest: TaskManifest): TaskCheck {
  const files = fixtureDirectory === undefined ? [] : filesIn(fixtureDirectory);
  for (const pattern of manifest.immutable ?? []) {
    if (!files.some((file) => matches(file.path, pattern))) throw new Error(`manifest.immutable 未匹配 fixture 文件：${pattern}`);
    if ((manifest.editable ?? []).some((editable) => files.some((file) => matches(file.path, pattern) && matches(file.path, editable)))) {
      throw new Error(`manifest 的 immutable 与 editable 重叠：${pattern}`);
    }
  }
  const source = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const manifest = ${JSON.stringify(manifest)};
const original = ${JSON.stringify(files)};
const runtimeDirectoryNames = ${JSON.stringify(RUNTIME_DIRECTORY_NAMES)};
const newRuntimeDirectory = (name, relative) => runtimeDirectoryNames.includes(name) && !original.some((file) => file.path === relative || file.path.startsWith(relative + "/"));
const matches = (file, pattern) => pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
const ignored = (name) => name === ".git" || name === "node_modules" || name === "archives" || name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
const current = new Map();
function walk(directory = ".", prefix = "") {
  for (const name of readdirSync(directory)) {
    if (ignored(name)) continue;
    const absolute = path.join(directory, name);
    const relative = prefix === "" ? name : prefix + "/" + name;
    const stat = lstatSync(absolute);
    assert.equal(stat.isSymbolicLink(), false, "manifest forbids symlinks: " + relative);
    if (stat.isDirectory()) {
      if (newRuntimeDirectory(name, relative)) continue;
      walk(absolute, relative);
    } else {
      assert.equal(stat.isFile(), true, "manifest requires regular files: " + relative);
      current.set(relative, { sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"), mode: stat.mode & 0o777 });
    }
  }
}
walk();
const editable = (name) => manifest.editable !== undefined && manifest.editable.some((pattern) => matches(name, pattern));
for (const file of original) {
  const immutable = (manifest.immutable ?? []).some((pattern) => matches(file.path, pattern)) || (manifest.editable !== undefined && !editable(file.path));
  if (immutable) assert.deepEqual(current.get(file.path), { sha256: file.sha256, mode: file.mode }, "immutable file changed or removed: " + file.path);
}
const existing = new Set(original.map((file) => file.path));
for (const file of current.keys()) {
  if (existing.has(file)) continue;
  assert.notEqual(manifest.allowNewFiles, false, "new file forbidden: " + file);
  if (manifest.editable !== undefined) assert.equal(editable(file), true, "new file outside editable paths: " + file);
}
`;
  return { kind: "command", argv: [process.execPath, "--input-type=module", "-e", source], timeoutMs: 10_000 };
}
