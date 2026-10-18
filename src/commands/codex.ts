import type { Command } from "commander";
import { homedir } from "node:os";
import path from "node:path";
import { loadHarness } from "../lib/bench/config.ts";
import { listCodexModels, readCodexAccount } from "../lib/bench/codex-account.ts";
import type { CodexAccountOptions } from "../lib/bench/codex-account.ts";
import { initCodexTarget, initHarnessTarget } from "../lib/bench/target-authoring.ts";
import type { InitCodexTargetOptions, InitHarnessTargetOptions } from "../lib/bench/target-authoring.ts";
import { findProjectRoot } from "../lib/paths.ts";
import type { BenchCommandDeps } from "./bench.ts";

export type CodexMetadataOptions = {
  harness?: string; codexHome?: string; credentialsStore?: string;
  timeoutMs?: string; includeHidden?: boolean; json?: boolean;
};

export async function runCodexMetadata(kind: "status" | "models", options: CodexMetadataOptions = {}, deps: BenchCommandDeps = {}): Promise<void> {
  const root = deps.root ?? findProjectRoot();
  const profile = loadHarness(root, options.harness ?? "codex");
  if (profile.adapter !== "codex") throw new Error("此命令需要 Codex harness profile");
  const credentialsStore = options.credentialsStore ?? "auto";
  if (credentialsStore !== "auto" && credentialsStore !== "file" && credentialsStore !== "keyring") throw new Error("--credentials-store 只能是 auto、file 或 keyring");
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
  if ((options.timeoutMs !== undefined && !/^\d+$/u.test(options.timeoutMs)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms 必须是 > 0 的安全整数");
  const codexHome = options.codexHome === undefined
    ? path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"))
    : path.resolve(root, options.codexHome);
  const request: CodexAccountOptions = { executable: profile.executable, codexHome, credentialsStore, timeoutMs, includeHidden: options.includeHidden === true };
  const log = deps.log ?? console.log;
  if (kind === "status") {
    const account = await readCodexAccount(request, deps);
    log(options.json === true ? JSON.stringify(account, null, 2)
      : `Codex 登录：${account.auth === "chatgpt" ? "ChatGPT 订阅" : account.auth === "api-key" ? "API key" : account.auth === "none" ? "未登录" : "未知认证方式"}${account.planType === null ? "" : `（${account.planType}）`}\n${account.auth === "chatgpt" ? "可用于 auth=chatgpt 的 Codex targets。" : "订阅测试需要先在相同 CODEX_HOME 下运行 codex login，选择 ChatGPT 登录。"}`);
  } else {
    const result = await listCodexModels(request, deps);
    if (result.account.auth !== "chatgpt") throw new Error("查询订阅模型需要当前 ChatGPT 登录；先在相同 CODEX_HOME 下运行 codex login，再执行 harness codex status。");
    log(options.json === true ? JSON.stringify(result, null, 2)
      : ["Codex 模型目录（目录可含缓存；实际可用性以该账号的执行结果为准）", "模型\t默认\t推理强度",
        ...result.models.map((model) => `${model.model}\t${model.isDefault ? "是" : "-"}\t${model.supportedReasoningEfforts.join(", ") || "未声明"}（默认 ${model.defaultReasoningEffort}）`),
      ].join("\n"));
  }
}

export function runCodexTargetInit(name: string, options: InitCodexTargetOptions, deps: BenchCommandDeps = {}): void {
  const result = initCodexTarget(deps.root ?? findProjectRoot(), name, options);
  (deps.log ?? console.log)(`已创建 target ${name}\n${JSON.stringify(result.target, null, 2)}\n\n先检查：bench run --task hello --targets ${name} --dry-run`);
}

export function runHarnessTargetInit(name: string, options: InitHarnessTargetOptions, deps: BenchCommandDeps = {}): void {
  const result = initHarnessTarget(deps.root ?? findProjectRoot(), name, options);
  (deps.log ?? console.log)(`已创建 target ${name}\n${JSON.stringify(result.target, null, 2)}\n\n先检查：bench run --task hello --targets ${name} --dry-run`);
}

export function registerCodexCommands(harness: Command, targets: Command): void {
  const codex = harness.command("codex").description("查看本机 Codex 的订阅登录与模型目录");
  for (const kind of ["status", "models"] as const) {
    const command = codex.command(kind).description(kind === "status" ? "读取登录类型，不显示凭据或账号标识" : "查询原生模型目录和支持的推理强度")
      .option("--harness <name>", "使用的 Codex profile", "codex")
      .option("--codex-home <path>", "认证目录；缺省使用当前 CODEX_HOME 或 ~/.codex")
      .option("--credentials-store <mode>", "auto、file 或 keyring", "auto")
      .option("--timeout-ms <n>", "查询时限毫秒", "30000")
      .option("--json", "输出安全元数据 JSON");
    if (kind === "models") command.option("--include-hidden", "包括原生目录标为 hidden 的模型");
    command.action((options: CodexMetadataOptions) => runCodexMetadata(kind, options));
  }
  targets.command("init <name>").description("创建 Codex / Claude Code / Cursor Agent target，不覆盖已有文件")
    .option("--harness <name>", "Codex、Claude Code 或 Cursor Agent profile", "codex-write")
    .option("--auth <mode>", "chatgpt、claude-subscription、api-key、cursor-login 或 cursor-api-key", "chatgpt")
    .requiredOption("--model <id>", "模型 ID 或原生别名；Codex 订阅目录通过 harness codex models 查询")
    .option("--reasoning-effort <effort>", "Codex 推理强度，须由所选模型支持")
    .option("--provider <name>", "api-key 模式的显式 provider")
    .option("--api-key-env <name>", "cursor-api-key 的环境变量名称，缺省 CURSOR_API_KEY")
    .option("--codex-home <path>", "Codex 订阅认证目录")
    .option("--credentials-store <mode>", "Codex 订阅凭据存储 auto、file 或 keyring")
    .option("--claude-config-dir <path>", "Claude Code 订阅配置目录；缺省使用当前 CLAUDE_CONFIG_DIR 或 ~/.claude")
    .action((name: string, options: InitHarnessTargetOptions) => runHarnessTargetInit(name, options));
}
