import { reviewTemplate } from "../lib/bench/report-supplement.ts";
import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "../lib/config.ts";
import { parseConcurrency } from "../lib/concurrency.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { parseRepeat } from "../lib/runs.ts";
import { listHarnesses, listTargets, listTasks, loadHarness, loadTask, resolveTarget } from "../lib/bench/config.ts";
import { renderBenchSummary } from "../lib/bench/render.ts";
import { describeBenchmark, runBenchmark } from "../lib/bench/runner.ts";
import { executionSecrets, redactExecutionValue } from "../lib/bench/executor.ts";
import { targetApiKeyEnv } from "../lib/bench/backend.ts";
import { listBenchmarks, readBenchmark } from "../lib/bench/store.ts";
import type { BenchmarkResult } from "../lib/bench/runner.ts";
import type { ExecutorDeps } from "../lib/bench/types.ts";
import { initTask } from "../lib/bench/task-authoring.ts";
import { validateTask } from "../lib/bench/task-validation.ts";
import { describeBenchSuite, listBenchSuites, listBenchSuiteRuns, loadBenchSuite, runBenchSuite } from "../lib/bench/suite.ts";
import type { BenchSuiteResult } from "../lib/bench/suite-types.ts";
import { buildBenchReport, renderBenchAnalysisCsv, renderBenchAnalysisMarkdown } from "../lib/bench/report.ts";
import { registerCodexCommands } from "./codex.ts";
import { registerClaudeCommands } from "./claude.ts";
import { registerCursorCommands } from "./cursor.ts";

export type BenchOptions = { task?: string; targets?: string; suite?: string; repeat?: string; concurrency?: string; timeoutMs?: string; dryRun?: boolean };
export type BenchCommandDeps = ExecutorDeps & { root?: string; log?: (text: string) => void; error?: (text: string) => void };

export function runBench(options: BenchOptions & { suite: string }, deps?: BenchCommandDeps): Promise<BenchSuiteResult | null>;
export function runBench(options: BenchOptions & { task: string; targets: string; suite?: never }, deps?: BenchCommandDeps): Promise<BenchmarkResult | null>;
export function runBench(options: BenchOptions, deps?: BenchCommandDeps): Promise<BenchmarkResult | BenchSuiteResult | null>;
export async function runBench(options: BenchOptions, deps: BenchCommandDeps = {}): Promise<BenchmarkResult | BenchSuiteResult | null> {
  const root = deps.root ?? findProjectRoot();
  const log = deps.log ?? console.log;
  if (options.suite !== undefined && (options.task !== undefined || options.targets !== undefined)) {
    throw new Error("--suite 不能与 --task / --targets 同时使用；targets 在套件文件中定义");
  }
  if (options.suite === undefined && (options.task === undefined || options.targets === undefined)) {
    throw new Error("需要 --suite，或同时提供 --task 与 --targets");
  }
  const timeoutMs = parseBenchTimeout(options.timeoutMs);
  if (options.dryRun !== true) loadEnv(root);
  if (options.suite !== undefined) {
    const input = loadBenchSuite(root, options.suite, {
      ...(options.repeat === undefined ? {} : { repeat: parseRepeat(options.repeat) }),
      ...(options.concurrency === undefined ? {} : { concurrency: parseConcurrency(options.concurrency) }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (options.dryRun === true) {
      const secrets = input.targets.flatMap((target) => executionSecrets(targetApiKeyEnv(target)));
      log(JSON.stringify(redactExecutionValue(describeBenchSuite(root, input), secrets), null, 2));
      return null;
    }
    const result = await runBenchSuite(root, input, { ...deps, onProgress: deps.error ?? console.error });
    log(`实验组 ${result.spec.id}\n\n${renderBenchAnalysisMarkdown(buildBenchReport(root, [result.spec.id]))}\n目录 ${result.dir}`);
    return result;
  }
  if (options.task === undefined || options.targets === undefined) throw new Error("缺少 task / targets");
  const names = [...new Set(options.targets.split(",").map((name) => name.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error("--targets 至少需要一个 target 名称");
  const loadedTask = loadTask(root, options.task);
  const input = { task: timeoutMs === undefined ? loadedTask : { ...loadedTask, timeoutMs }, targets: names.map((name) => resolveTarget(root, name)),
    repeat: parseRepeat(options.repeat), concurrency: parseConcurrency(options.concurrency) };
  if (options.dryRun === true) {
    const secrets = input.targets.flatMap((target) => executionSecrets(targetApiKeyEnv(target)));
    log(JSON.stringify(redactExecutionValue(describeBenchmark(root, input), secrets), null, 2));
    return null;
  }
  const result = await runBenchmark(root, input, { ...deps, onProgress: deps.error ?? console.error });
  log(`benchmark ${result.spec.id}\n\n${renderBenchSummary(result.records)}\n\n目录 ${result.dir}`);
  return result;
}

function parseBenchTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--timeout-ms 必须是 > 0 的安全整数");
  return parsed;
}

export function runTasksInit(name: string, template: string, deps: BenchCommandDeps = {}): void {
  if (template !== "repair" && template !== "data" && template !== "answer") {
    throw new Error("--template 只能是 repair、data 或 answer");
  }
  const result = initTask(deps.root ?? findProjectRoot(), name, template);
  (deps.log ?? console.log)(`任务 ${result.name}（${result.template}）\n${result.files.join("\n")}\n\n下一步：tasks validate ${result.name}`);
}

export async function runTasksValidate(name: string | undefined, all: boolean, deps: BenchCommandDeps = {}): Promise<boolean> {
  if ((name === undefined && !all) || (name !== undefined && all)) throw new Error("提供一个任务名，或使用 --all；二者不能同时使用");
  const root = deps.root ?? findProjectRoot();
  const names = all ? listTasks(root) : [name ?? ""];
  let passed = true;
  for (const taskName of names) {
    try {
      const result = await validateTask(root, taskName, deps);
      passed = result.passed && passed;
      (deps.log ?? console.log)(`${taskName}：${result.passed ? "通过" : "失败"}\n${result.checks.map((check) => `  ${check.passed ? "通过" : "失败"} ${check.name}：${check.detail}`).join("\n")}${result.diagnostics.length === 0 ? "" : `\n${result.diagnostics.map((detail) => `  ${detail}`).join("\n")}`}`);
    } catch (error) {
      passed = false;
      (deps.error ?? console.error)(`${taskName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (names.length === 0) (deps.log ?? console.log)("没有可校验的任务。");
  return passed;
}

export type BenchReportOptions = { review?: string; pricing?: string; scenario?: string; format?: string; output?: string };

export function runBenchReport(ids: readonly string[], options: BenchReportOptions = {}, deps: BenchCommandDeps = {}): void {
  const format = options.format ?? "markdown";
  if (format !== "markdown" && format !== "json" && format !== "csv") throw new Error("--format 只能是 markdown、json 或 csv");
  if (ids.length === 0) throw new Error("至少提供一个 b_… 或 e_… 实验 ID");
  const report = buildBenchReport(deps.root ?? findProjectRoot(), ids, {
    ...(options.review === undefined ? {} : { reviewFile: options.review }),
    ...(options.pricing === undefined ? {} : { pricingFile: options.pricing }),
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
  });
  const content = format === "json" ? `${JSON.stringify(report, null, 2)}\n`
    : format === "csv" ? renderBenchAnalysisCsv(report) : renderBenchAnalysisMarkdown(report);
  if (options.output !== undefined) {
    const file = path.resolve(options.output);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
    (deps.log ?? console.log)(`报告已保存：${file}`);
  } else (deps.log ?? console.log)(content);
}

export function runBenchLs(deps: BenchCommandDeps = {}): void {
  const root = deps.root ?? findProjectRoot();
  const { entries, warnings } = listBenchmarks(root);
  const suites = listBenchSuiteRuns(root);
  for (const warning of [...warnings, ...suites.warnings]) (deps.error ?? console.error)(warning);
  const rows = [
    ...entries.map(({ spec, completed }) => ({ createdAt: spec.createdAt, text: `${spec.id}\t${spec.createdAt}\t${spec.task.name}\t${String(completed)}/${String(spec.targets.length * spec.repeat)}` })),
    ...suites.entries.map(({ spec, state }) => ({ createdAt: spec.createdAt, text: `${spec.id}\t${spec.createdAt}\t套件 ${spec.name}\t${state.status}\t${String(state.completed)}/${String(state.total)}` })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  (deps.log ?? console.log)(rows.length === 0 ? "还没有任务实验。用 bench run --task hello --targets llm-ds-pro 开始。" : rows.map((row) => row.text).join("\n"));
}

export function runBenchShow(id: string, deps: BenchCommandDeps = {}): void {
  if (id.startsWith("e_")) {
    runBenchReport([id], {}, deps);
    return;
  }
  const { dir, spec, records } = readBenchmark(deps.root ?? findProjectRoot(), id);
  (deps.log ?? console.log)(`benchmark ${id}\n任务 ${spec.task.name}  fixture ${spec.fixture.hash}\n\n${renderBenchSummary(records)}\n\n目录 ${dir}`);
}

export function registerBenchCommands(program: Command): void {
  const targets = program.command("targets").description("查看实验对象：直接 LLM 或 harness + backend");
  targets.command("ls").action(() => console.log(listTargets(findProjectRoot()).join("\n")));
  targets.command("show <name>").action((name: string) => {
    const root = findProjectRoot(); loadEnv(root);
    console.log(JSON.stringify(resolveTarget(root, name), null, 2));
  });
  const tasks = program.command("tasks").description("查看任务输入、fixture 与验收条件");
  tasks.command("ls").action(() => console.log(listTasks(findProjectRoot()).join("\n")));
  tasks.command("show <name>").action((name: string) => console.log(JSON.stringify(loadTask(findProjectRoot(), name), null, 2)));
  tasks.command("init <name>").description("从模板创建任务、可信验收和离线自测素材")
    .option("--template <kind>", "repair、data 或 answer", "repair")
    .action((name: string, options: { template: string }) => runTasksInit(name, options.template));
  tasks.command("validate [name]").description("离线校验任务与自测用例，不启动模型或 harness")
    .option("--all", "检查所有任务")
    .action(async (name: string | undefined, options: { all?: boolean }) => {
      if (!await runTasksValidate(name, options.all === true)) process.exitCode = 1;
    });
  const harness = program.command("harness").description("查看工具执行环境（独立于 provider）");
  harness.command("ls").action(() => console.log(listHarnesses(findProjectRoot()).join("\n")));
  harness.command("show <name>").action((name: string) => console.log(JSON.stringify(loadHarness(findProjectRoot(), name), null, 2)));
  registerCodexCommands(harness, targets);
  registerClaudeCommands(harness);
  registerCursorCommands(harness);
  const bench = program.command("bench").description("统一运行直接 LLM 与 harness 任务实验");
  const suites = bench.command("suites").description("查看多任务实验套件");
  suites.command("ls").action(() => console.log(listBenchSuites(findProjectRoot()).join("\n")));
  suites.command("show <name>").action((name: string) => console.log(JSON.stringify(loadBenchSuite(findProjectRoot(), name), null, 2)));
  bench.command("run")
    .option("--task <name>", "单任务名，与 --targets 一起使用")
    .option("--targets <names>", "逗号分隔的 target 名称")
    .option("--suite <name>", "bench-suites 中的多任务套件，与 --task/--targets 互斥")
    .option("--repeat <n>", "每个 target 的独立采样次数；单题缺省 1，套件使用定义值（缺省 3）")
    .option("--concurrency <n>", "并发采样数，缺省 3")
    .option("--timeout-ms <n>", "本轮执行时限毫秒，覆盖任务预算并保存快照")
    .option("--dry-run", "只解析配置与进程计划，不发请求、不启动 CLI、不落盘")
    .action(async (options: BenchOptions) => {
      const result = await runBench(options);
      if (result?.failed === true) process.exitCode = 1;
    });
  bench.command("ls").action(() => runBenchLs());
  bench.command("show <id>").action((id: string) => runBenchShow(id));
  bench.command("review-template <id>").description("生成绑定冻结记录的人工评审/用量核对模板")
    .requiredOption("--output <file>", "新 JSON 文件，拒绝覆盖")
    .action((id: string, options: { output: string }) => {
      const template = reviewTemplate(findProjectRoot(), id);
      writeFileSync(path.resolve(options.output), JSON.stringify(template, null, 2) + "\n", { flag: "wx" });
    });
  bench.command("report <ids...>").description("离线汇总实验组或旧实验，不修改原记录")
    .option("--review <file>", "绑定记录指纹的人工评审及用量核对 JSON")
    .option("--pricing <file>", "用户维护的价格 JSON；不使用 harness 报价估算后端费用")
    .option("--scenario <name>", "显式价格情景，例如 offPeak；缺省列出全部情景")
    .option("--format <kind>", "markdown、json 或 csv", "markdown")
    .option("--output <file>", "保存到新文件，拒绝覆盖已有文件")
    .action((ids: string[], options: BenchReportOptions) => runBenchReport(ids, options));
}
