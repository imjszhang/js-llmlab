import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { formatError, redactSecrets } from "../client.ts";
import { executionSecrets } from "./executor.ts";
import { runProcess } from "./process.ts";
import type { BenchTask, ExecutionResult, GradeResult, ProcessRunner, TaskCheck } from "./types.ts";

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function redactCheck(check: TaskCheck, secrets: readonly string[]): TaskCheck {
  const clean = (text: string) => redactSecrets(text, secrets);
  if (check.kind === "command") return { ...check, argv: check.argv.map(clean) };
  if (check.kind === "output-contains" || check.kind === "output-equals") return { ...check, text: clean(check.text) };
  if (check.kind === "file-contains") return { ...check, path: clean(check.path), text: clean(check.text) };
  return { ...check, path: clean(check.path) };
}

/** Resolve existing ancestors too, so missing paths behind an outside symlink are rejected. */
async function checkedFilePath(workspace: string, relative: string): Promise<string | null> {
  const root = path.resolve(workspace);
  const candidate = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !contained(root, candidate)) throw new Error("验收文件路径越出任务工作目录");
  const actualRoot = await realpath(root);
  let current = candidate;
  for (;;) {
    try {
      const entry = await lstat(current);
      let actual: string;
      try {
        actual = await realpath(current);
      } catch (error) {
        if (entry.isSymbolicLink()) throw new Error("验收文件包含无法解析的符号链接");
        throw error;
      }
      if (!contained(actualRoot, actual)) throw new Error("验收文件的符号链接越出任务工作目录");
      return current === candidate ? actual : null;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function gradeTask(
  task: BenchTask,
  execution: ExecutionResult,
  workspace: string,
  deps: { runProcess?: ProcessRunner } = {},
): Promise<GradeResult> {
  if (execution.status !== "completed" || task.checks.length === 0) return { status: "not-run", checks: [] };
  const checks: GradeResult["checks"] = [];
  const secrets = executionSecrets("");
  const clean = (text: string) => redactSecrets(text, secrets);
  let checkerError = false;
  for (const check of task.checks) {
    try {
      if (check.kind === "output-contains" || check.kind === "output-equals") {
        const passed = check.kind === "output-contains" ? execution.text.includes(check.text) : execution.text.trim() === check.text.trim();
        checks.push({ check, passed, detail: check.kind === "output-contains"
          ? passed ? "输出包含指定文本" : "输出不包含指定文本"
          : passed ? "输出与指定文本一致（忽略首尾空白）" : "输出与指定文本不一致" });
      } else if (check.kind === "file-exists" || check.kind === "file-contains") {
        const file = await checkedFilePath(workspace, check.path);
        const exists = file !== null && (await stat(file)).isFile();
        const passed = exists && (check.kind === "file-exists" || (await readFile(file, "utf8")).includes(check.text));
        checks.push({ check, passed, detail: passed ? "文件验收通过" : exists ? "文件不包含指定文本" : "文件不存在" });
      } else {
        const [executable, ...args] = check.argv;
        if (executable === undefined || executable === "") throw new Error("验收命令不能为空");
        const result = await (deps.runProcess ?? runProcess)({
          executable, args, cwd: workspace, env: {}, timeoutMs: check.timeoutMs,
        });
        const error = result.error !== null || result.timedOut || result.exitCode === null;
        if (error) checkerError = true;
        const passed = !error && result.exitCode === 0;
        checks.push({
          check, passed,
          detail: clean(result.error ?? (result.timedOut ? "验收命令超时" : result.signal !== null
            ? `验收命令被信号 ${result.signal} 终止` : `验收命令退出码 ${String(result.exitCode)}`)),
          stdout: clean(result.stdout), stderr: clean(result.stderr),
        });
      }
    } catch (error) {
      checkerError = true;
      checks.push({ check, passed: false, detail: clean(formatError(error)) });
    }
  }
  return {
    status: checkerError ? "error" : checks.every((check) => check.passed) ? "passed" : "failed",
    checks: checks.map((entry) => ({ ...entry, check: redactCheck(entry.check, secrets) })),
  };
}
