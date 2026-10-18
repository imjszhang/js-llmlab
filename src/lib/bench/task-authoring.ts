import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateBenchName, validateRelativePath } from "./config.ts";

export type TaskTemplate = "repair" | "data" | "answer";
export type InitTaskResult = { name: string; template: TaskTemplate; files: string[] };

type FilePlan = { path: string; content: string };

const repairChecker = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const cases = [[2, 3], [-4, 7], [0, 0], [1.25, 2.5], [100, -200]];
// The trusted parent verifies a complete result; an early process.exit(0) is insufficient.
const source = 'import { add } from "./src/add.mjs"; const cases = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(cases.map(([a,b]) => add(a,b))));';
const run = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(cases)], { encoding: "utf8", timeout: 3000 });
assert.equal(run.error, undefined, "candidate process must finish");
assert.equal(run.status, 0, run.stderr);
assert.deepEqual(JSON.parse(run.stdout), cases.map(([a,b]) => a + b));
console.log("repair acceptance passed");
`;

const dataChecker = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
// The checker lives outside the candidate workspace and is frozen before execution.
const run = spawnSync(process.execPath, ["transform.mjs"], { encoding: "utf8", timeout: 3000 });
assert.equal(run.error, undefined, "transform must finish");
assert.equal(run.status, 0, run.stderr);
assert.deepEqual(JSON.parse(readFileSync("summary.json", "utf8")), [{ category: "alpha", total: 3 }, { category: "beta", total: 4 }]);
console.log("data acceptance passed");
`;

function planTask(name: string, template: TaskTemplate): FilePlan[] {
  const fixture = `tasks/fixtures/${name}`;
  const selfTests = `tasks/self-tests/${name}`;
  const promptFile = `tasks/prompts/${name}.md`;
  const checker = `tasks/checks/${name}.mjs`;
  const files: FilePlan[] = [];
  const spec = template === "repair"
    ? "# 加法修复\n\n修复 src/add.mjs 的 add(a, b)，返回两个有限数值的和。支持负数、零与小数。只修改现有 src/add.mjs；不要添加文件或修改 SPEC.md。\n"
    : template === "data"
      ? "# 分类汇总\n\ninput.csv 的列为 category,amount，按 category 汇总 amount，按分类名称升序排列。完成 transform.mjs，运行 node transform.mjs 后生成 summary.json，格式为 [{\"category\":\"alpha\",\"total\":3},…]。输入与 SPEC.md 不可修改；只可修改 transform.mjs 并生成 summary.json。\n"
      : "# 简短回答\n\n计算 16 + 26。只回答结果 42，不需要修改任何文件。\n";
  const task: Record<string, unknown> = {
    name, promptFile, fixture, timeoutMs: template === "answer" ? 120_000 : 300_000,
    checks: template === "answer" ? [{ kind: "output-equals", text: "42" }] : [{ kind: "script", file: checker, timeoutMs: 10_000 }],
    manifest: template === "repair"
      ? { immutable: ["SPEC.md"], editable: ["src/add.mjs"], allowNewFiles: false }
      : template === "data"
        ? { immutable: ["SPEC.md", "input.csv"], editable: ["transform.mjs", "summary.json"], allowNewFiles: true }
        : { immutable: ["SPEC.md"], editable: [], allowNewFiles: false },
  };
  files.push({ path: promptFile, content: `${spec}\n请直接完成任务。\n` }, { path: `${fixture}/SPEC.md`, content: spec });
  if (template === "repair") {
    task.requires = "workspace-write";
    task.selfTest = {
      initial: "fail", reference: { files: `${selfTests}/reference` },
      negative: [{ name: "multiply", files: `${selfTests}/negative-multiply` }],
    };
    files.push(
      { path: `${fixture}/src/add.mjs`, content: "export function add(a, b) { return a - b; }\n" },
      { path: checker, content: repairChecker },
      { path: `${selfTests}/reference/src/add.mjs`, content: "export function add(a, b) { return a + b; }\n" },
      { path: `${selfTests}/negative-multiply/src/add.mjs`, content: "export function add(a, b) { return a * b; }\n" },
    );
  } else if (template === "data") {
    task.requires = "workspace-write";
    task.selfTest = {
      initial: "fail", reference: { files: `${selfTests}/reference` },
      negative: [{ name: "wrong-total", files: `${selfTests}/negative-wrong-total` }],
    };
    const wrong = 'import { writeFileSync } from "node:fs";\nwriteFileSync("summary.json", "[]\\n");\n';
    files.push(
      { path: `${fixture}/input.csv`, content: "category,amount\nbeta,4\nalpha,1\nalpha,2\n" },
      { path: `${fixture}/transform.mjs`, content: wrong },
      { path: checker, content: dataChecker },
      { path: `${selfTests}/reference/transform.mjs`, content: `import { readFileSync, writeFileSync } from "node:fs";
const totals = new Map();
for (const row of readFileSync("input.csv", "utf8").trim().split("\\n").slice(1)) {
  const [category, amount] = row.split(",");
  totals.set(category, (totals.get(category) ?? 0) + Number(amount));
}
const result = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([category, total]) => ({ category, total }));
writeFileSync("summary.json", JSON.stringify(result, null, 2) + "\\n");
` },
      { path: `${selfTests}/negative-wrong-total/transform.mjs`, content: 'import { writeFileSync } from "node:fs";\n// Incorrectly keeps the first amount instead of summing duplicate categories.\nwriteFileSync("summary.json", JSON.stringify([{ category: "alpha", total: 1 }, { category: "beta", total: 4 }]));\n' },
    );
  } else {
    task.selfTest = { initial: "fail", reference: { output: "42" }, negative: [{ name: "wrong-answer", output: "142" }] };
  }
  files.push({ path: `tasks/${name}.json`, content: `${JSON.stringify(task, null, 2)}\n` });
  return files;
}

function assertDestination(root: string, relative: string, allowExistingDirectory: boolean): void {
  validateRelativePath(relative);
  let cursor = root;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    if (part === "archives" || part === "node_modules" || part === ".git" || part === ".env"
        || (part.startsWith(".env.") && part !== ".env.example")) throw new Error(`路径不能写入私密或忽略目录：${relative}`);
    cursor = path.join(cursor, part);
    let entry;
    try { entry = lstatSync(cursor); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (entry.isSymbolicLink()) throw new Error(`不允许符号链接：${relative}`);
    if (index === parts.length - 1 && !(allowExistingDirectory && entry.isDirectory())) throw new Error(`拒绝覆盖已有路径：${relative}`);
    if (!entry.isDirectory()) throw new Error(`父路径必须是目录：${relative}`);
  }
}

/** Preflight every destination, then create with exclusive writes. Existing content is never overwritten. */
export function initTask(root: string, name: string, template: TaskTemplate): InitTaskResult {
  validateBenchName(name);
  if (template !== "repair" && template !== "data" && template !== "answer") throw new Error("template 只能是 repair、data 或 answer");
  const absoluteRoot = realpathSync(root);
  const files = planTask(name, template);
  assertDestination(absoluteRoot, `tasks/fixtures/${name}`, false);
  assertDestination(absoluteRoot, `tasks/self-tests/${name}`, false);
  for (const file of files) assertDestination(absoluteRoot, file.path, false);
  const created: string[] = [];
  try {
    for (const file of files) {
      const absolute = path.join(absoluteRoot, file.path);
      mkdirSync(path.dirname(absolute), { recursive: true });
      // Recheck ancestors after creating them, including a possible pre-existing symlink.
      assertDestination(absoluteRoot, file.path, false);
      writeFileSync(absolute, file.content, { encoding: "utf8", flag: "wx" });
      created.push(absolute);
    }
  } catch (error) {
    for (const absolute of created.reverse()) if (existsSync(absolute)) unlinkSync(absolute);
    throw error;
  }
  return { name, template, files: files.map((file) => file.path) };
}
