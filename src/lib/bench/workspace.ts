import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "./config.ts";
import { isNewRuntimeDirectory } from "./runtime-directories.ts";
import type { BenchTask, FileChange, FixtureFile, FixtureSnapshot } from "./types.ts";

function ignored(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "archives" || name === ".env"
    || (name.startsWith(".env.") && name !== ".env.example");
}

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function within(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function safeAbsolute(value: string): string {
  const absolute = path.resolve(value);
  let ancestor = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = lstatSync(ancestor);
      if (stat.isSymbolicLink()) throw new Error(`不允许符号链接：${ancestor}`);
      // realpath 归一化 macOS /var、/tmp 等系统路径；目录内部的链接由 walk 拒绝。
      return path.join(realpathSync(ancestor), ...missing.reverse());
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      missing.push(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

function walk(directory: string, prefix = "", originalPaths?: readonly string[]): FixtureFile[] {
  const files: FixtureFile[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (ignored(name)) continue;
    const absolute = path.join(directory, name);
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`不允许符号链接：${relative}`);
    if (stat.isDirectory()) {
      // Only a real, newly created dependency directory may contain untracked links.
      // Fixture snapshots stay strict; existing inputs with these names stay visible.
      if (originalPaths !== undefined && isNewRuntimeDirectory(name, relative, originalPaths)) continue;
      files.push(...walk(absolute, relative, originalPaths));
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      files.push({ path: relative, sha256: digest(content), bytes: content.length, mode: stat.mode & 0o777 });
    } else throw new Error(`不支持的文件类型：${relative}`);
  }
  return files;
}

/** Pass the frozen fixture only for candidate snapshots; fixture/overlay snapshots remain strict. */
export function snapshotWorkspace(workspace: string, fixture?: FixtureSnapshot): FixtureSnapshot {
  const absolute = safeAbsolute(workspace);
  if (!lstatSync(absolute).isDirectory()) throw new Error(`workspace 必须是目录：${workspace}`);
  const files = walk(absolute, "", fixture?.files.map((file) => file.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { hash: digest(JSON.stringify(files)), files };
}

export function snapshotFixture(root: string, task: BenchTask): FixtureSnapshot {
  return task.fixture === undefined
    ? { hash: digest(JSON.stringify([])), files: [] }
    : snapshotWorkspace(resolveProjectPath(root, task.fixture));
}

/** 每次采样从同一源复制，绝不复用可被 harness 改动的工作区。 */
export function materializeFixture(root: string, task: BenchTask, workspace: string): void {
  const source = task.fixture === undefined ? undefined : resolveProjectPath(root, task.fixture);
  const destination = safeAbsolute(workspace);
  const projectRoot = realpathSync(root);
  if (destination === projectRoot || within(destination, projectRoot)) {
    throw new Error("workspace 不能是项目根目录或其父目录");
  }
  if (source !== undefined && (within(source, destination) || within(destination, source))) {
    throw new Error("workspace 和 fixture 目录不能重叠");
  }
  if (existsSync(destination) && (!lstatSync(destination).isDirectory() || readdirSync(destination).length !== 0)) {
    throw new Error("workspace 必须是新目录或空目录");
  }
  const snapshot = source === undefined ? null : snapshotWorkspace(source);
  mkdirSync(destination, { recursive: true });
  for (const file of snapshot?.files ?? []) {
    if (source === undefined) break;
    const from = path.join(source, file.path);
    const to = path.join(destination, file.path);
    // 同时核对路径和文件本身，避免复制期间通过链接写回源文件。
    safeAbsolute(from);
    safeAbsolute(to);
    if (!within(destination, to) || within(source, to)) throw new Error("fixture 复制路径越界");
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    chmodSync(to, file.mode);
    if (digest(readFileSync(to)) !== file.sha256) throw new Error(`fixture 在复制时发生变化：${file.path}`);
  }
}

export function diffSnapshots(before: FixtureSnapshot, after: FixtureSnapshot): FileChange[] {
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const changes: FileChange[] = [];
  for (const name of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const old = oldFiles.get(name);
    const current = newFiles.get(name);
    if (old !== undefined && current !== undefined && old.sha256 === current.sha256 && old.mode === current.mode) continue;
    changes.push({ path: name, kind: old === undefined ? "added" : current === undefined ? "deleted" : "modified", before: old?.sha256 ?? null, after: current?.sha256 ?? null });
  }
  return changes;
}
