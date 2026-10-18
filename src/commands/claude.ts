import type { Command } from "commander";
import { resolveTargetDefinition } from "../lib/bench/config.ts";
import { readClaudeAccount } from "../lib/bench/claude-account.ts";
import { findProjectRoot } from "../lib/paths.ts";
import type { BenchCommandDeps } from "./bench.ts";

export type ClaudeStatusOptions = {
  harness?: string; claudeConfigDir?: string; timeoutMs?: string; json?: boolean;
};

/** Native auth metadata only. Never load .env, request a completion, or reveal account identifiers. */
export async function runClaudeStatus(options: ClaudeStatusOptions = {}, deps: BenchCommandDeps = {}): Promise<void> {
  const root = deps.root ?? findProjectRoot();
  const target = resolveTargetDefinition(root, {
    name: "claude-status", kind: "harness", harness: options.harness ?? "claude-code",
    backend: { auth: "claude-subscription", model: "sonnet",
      ...(options.claudeConfigDir === undefined ? {} : { claudeConfigDir: options.claudeConfigDir }) },
  });
  if (target.kind !== "harness" || target.backend.auth !== "claude-subscription") throw new Error("此命令需要 Claude Code harness profile");
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
  if ((options.timeoutMs !== undefined && !/^\d+$/u.test(options.timeoutMs)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms 必须是 > 0 的安全整数");
  }
  const account = await readClaudeAccount({
    executable: target.profile.executable, claudeConfigDir: target.backend.claudeConfigDir,
    claudeConfigDirMode: target.backend.claudeConfigDirMode, timeoutMs,
  }, deps);
  (deps.log ?? console.log)(options.json === true ? JSON.stringify(account, null, 2)
    : `Claude Code 登录：${account.auth === "claude-subscription" ? "Claude 订阅" : account.auth === "api-key" ? "API key" : account.auth === "none" ? "未登录" : "其他认证方式"}\n${account.auth === "claude-subscription"
      ? "可用于 auth=claude-subscription 的 targets；模型权限与剩余额度由原生 Claude Code 决定。"
      : "需要先在相同配置目录下使用原生 claude auth login 登录 Claude 账号。"}`);
}

export function registerClaudeCommands(harness: Command): void {
  harness.command("claude-code").description("Claude Code 原生订阅登录")
    .command("status").description("读取登录类型，不显示凭据或账号标识")
    .option("--harness <name>", "Claude Code profile", "claude-code")
    .option("--claude-config-dir <path>", "显式账户目录；默认保留当前原生登录命名空间")
    .option("--timeout-ms <n>", "查询时限毫秒", "30000")
    .option("--json", "输出安全元数据 JSON")
    .action((options: ClaudeStatusOptions) => runClaudeStatus(options));
}
