import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTask, resolveProjectPath } from "./config.ts";
import { gradeTask } from "./grader.ts";
import { materializeFixture, snapshotFixture, snapshotWorkspace } from "./workspace.ts";
import type { ExecutionResult, ProcessRunner, TaskSelfTestCase } from "./types.ts";

export type TaskValidationResult = {
  name: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  diagnostics: string[];
};

function simulatedExecution(text: string): ExecutionResult {
  return {
    status: "completed", text, reasoning: null, usage: null, cost: null, sessionId: null,
    responseModel: null, events: [], error: null, latencyMs: 0, exitCode: 0, stdout: text,
    stderr: "", raw: null, harnessVersion: null, usageSource: null, costSource: null,
  };
}

function applyOverlay(root: string, relative: string, workspace: string): void {
  const source = resolveProjectPath(root, relative);
  const snapshot = snapshotWorkspace(source);
  for (const file of snapshot.files) {
    const from = resolveProjectPath(root, `${relative}/${file.path}`);
    const to = path.join(workspace, file.path);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    const hash = createHash("sha256").update(readFileSync(to)).digest("hex");
    if (hash !== file.sha256) throw new Error(`selfTest overlay 在复制时发生变化：${file.path}`);
  }
}

/** Run only local, trusted acceptance code in throwaway workspaces; no provider or harness is loaded. */
export async function validateTask(
  root: string,
  name: string,
  deps: { runProcess?: ProcessRunner } = {},
): Promise<TaskValidationResult> {
  const result: TaskValidationResult = { name, passed: false, checks: [], diagnostics: [] };
  let temporary: string | undefined;
  try {
    const task = loadTask(root, name);
    const fixture = snapshotFixture(root, task);
    if (task.checks.length === 0) throw new Error("任务至少需要一条验收条件");
    result.checks.push({ name: "structure", passed: true, detail: `配置、可信 checker 与 fixture 有效（${fixture.files.length} 个文件）` });
    if (task.selfTest === undefined) {
      result.diagnostics.push("未配置 selfTest：仅完成结构校验，未验证初始状态、参考解或负例。旧任务无需迁移。");
    } else {
      temporary = mkdtempSync(path.join(tmpdir(), "js-llmlab-task-validation-"));
      const runCase = async (caseName: string, candidate: TaskSelfTestCase, expected: "pass" | "fail"): Promise<void> => {
        if (temporary === undefined) throw new Error("缺少临时工作区");
        const workspace = path.join(temporary, caseName);
        materializeFixture(root, task, workspace);
        if (candidate.files !== undefined) applyOverlay(root, candidate.files, workspace);
        const grade = await gradeTask(task, simulatedExecution(candidate.output ?? ""), workspace, deps);
        const passed = grade.status === (expected === "pass" ? "passed" : "failed");
        result.checks.push({
          name: caseName, passed,
          detail: `预期${expected === "pass" ? "通过" : "失败"}，实际 ${grade.status}${passed ? "" : `；${grade.checks.filter((check) => !check.passed).map((check) => check.detail).join("；")}`}`,
        });
      };
      await runCase("initial", {}, task.selfTest.initial);
      await runCase("reference", task.selfTest.reference, "pass");
      for (const [index, candidate] of task.selfTest.negative.entries()) {
        await runCase(`negative-${index + 1}-${candidate.name}`, candidate, "fail");
      }
      result.diagnostics.push("已在互相独立的临时工作区验证初始状态、参考解和全部负例；未请求模型或启动 harness。");
    }
    result.passed = result.checks.every((check) => check.passed);
  } catch (error) {
    result.checks.push({ name: "validation", passed: false, detail: error instanceof Error ? error.message : String(error) });
    result.passed = false;
  } finally {
    if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  }
  return result;
}
