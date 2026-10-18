import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessRunner } from "./types.ts";

export type ClaudeAccountStatus = {
  auth: "claude-subscription" | "api-key" | "none" | "other";
  subscriptionType: string | null;
};
export type ClaudeAccountOptions = {
  executable: string;
  claudeConfigDir: string;
  claudeConfigDirMode: "default" | "explicit";
  timeoutMs?: number;
};
export type ClaudeAccountDeps = { runProcess?: ProcessRunner };
export class ClaudeMetadataTimeoutError extends Error {
  constructor() { super("Claude Code 登录状态查询超时"); this.name = "ClaudeMetadataTimeoutError"; }
}

type ClaudeAuthLocation = Pick<ClaudeAccountOptions, "claudeConfigDir" | "claudeConfigDirMode">;

function validateLocation(options: ClaudeAuthLocation): void {
  if (!path.isAbsolute(options.claudeConfigDir) || /[\u0000-\u001f\u007f]/u.test(options.claudeConfigDir)) {
    throw new Error("Claude Code 登录目录必须是绝对路径");
  }
  if (options.claudeConfigDirMode !== "default" && options.claudeConfigDirMode !== "explicit") {
    throw new Error("不支持的 Claude Code 登录目录模式");
  }
  if (options.claudeConfigDirMode === "default" && path.basename(path.resolve(options.claudeConfigDir)) !== ".claude") {
    throw new Error("Claude Code 默认登录目录必须是原 HOME 下的 .claude");
  }
}

/**
 * Keep the native auth namespace, without inspecting credentials or mutating
 * the parent environment. Setting CLAUDE_CONFIG_DIR even to ~/.claude selects
 * a different macOS Keychain service from leaving it unset. Default auth must
 * therefore preserve the original HOME; explicit auth can use an isolated HOME.
 * XDG/cache locations remain isolated in both cases. Callers must use the
 * bounded process runner's clean environment, not merge process.env into this.
 */
export function claudeSubscriptionEnvironment(options: ClaudeAuthLocation, isolatedHome: string): Record<string, string> {
  validateLocation(options);
  if (!path.isAbsolute(isolatedHome) || /[\u0000-\u001f\u007f]/u.test(isolatedHome)) throw new Error("Claude Code 临时 HOME 必须是绝对路径");
  const home = options.claudeConfigDirMode === "default" ? path.dirname(path.resolve(options.claudeConfigDir)) : isolatedHome;
  return {
    HOME: home,
    USERPROFILE: home,
    ...(options.claudeConfigDirMode === "explicit" ? { CLAUDE_CONFIG_DIR: options.claudeConfigDir } : {}),
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
    XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    XDG_STATE_HOME: path.join(isolatedHome, ".local", "state"),
    CLAUDE_CODE_TMPDIR: path.join(isolatedHome, "tmp"),
    CLAUDE_CODE_DEBUG_LOGS_DIR: path.join(isolatedHome, "claude-debug.log"),
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    NO_COLOR: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

/** Native transport only. Callers must redact these values from saved plans. */
export function claudeNetworkEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Read only the native CLI's authentication metadata. Never export or copy
 * credentials, execute apiKeyHelper intentionally, or log in/out. Safe and
 * restricted modes preserve native auth while excluding personal extensions;
 * administrator policy remains effective. --bare must not be used: it disables
 * OAuth and Keychain access. No native identity fields or diagnostics escape.
 */
export async function readClaudeAccount(options: ClaudeAccountOptions, deps: ClaudeAccountDeps = {}): Promise<ClaudeAccountStatus> {
  validateLocation(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Claude Code 登录查询 timeoutMs 必须是正整数");
  if (options.executable.trim() === "" || /[\u0000-\u001f\u007f]/u.test(options.executable)) throw new Error("Claude Code executable 不能为空");
  const started = Date.now();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "js-llmlab-claude-account-"));
  try {
    const home = path.join(temporary, "home");
    await mkdir(home);
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new ClaudeMetadataTimeoutError();
    const settings = JSON.stringify({
      disableAllHooks: true,
      disableAgentView: true,
      disableRemoteControl: true,
      disableWorkflows: true,
      permissions: { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true },
    });
    const runner = deps.runProcess ?? runProcess;
    const result = await runner({
      executable: options.executable,
      args: ["--safe-mode", "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "", "--settings", settings, "auth", "status", "--json"],
      cwd: temporary,
      env: { ...claudeSubscriptionEnvironment(options, home), ...claudeNetworkEnvironment() },
      timeoutMs: remaining,
      maxOutputBytes: 32 * 1024,
    }).catch(() => { throw new Error("Claude Code 登录状态查询失败；请检查 CLI 安装与本机配置"); });
    if (result.timedOut || Date.now() - started >= timeoutMs) throw new ClaudeMetadataTimeoutError();
    if (result.error !== null || result.signal !== null || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw new Error("Claude Code 登录状态查询失败；请检查 CLI 安装与本机配置");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Claude Code 返回了无效的登录状态响应"); }
    const data = object(parsed);
    if (data === null || typeof data.loggedIn !== "boolean" || typeof data.authMethod !== "string"
      || result.exitCode !== (data.loggedIn ? 0 : 1)) throw new Error("Claude Code 返回了无效的登录状态元数据");
    // configDirectory is present from v2.1.268. Fail closed when an older CLI
    // cannot confirm that the selected native auth directory is the one read.
    if (typeof data.configDirectory !== "string" || !path.isAbsolute(data.configDirectory)
      || /[\u0000-\u001f\u007f]/u.test(data.configDirectory)
      || path.resolve(data.configDirectory).normalize("NFC") !== path.resolve(options.claudeConfigDir).normalize("NFC")) {
      throw new Error("Claude Code 未确认预期登录目录；请使用 2.1.268 或更新版本并检查目录配置");
    }
    if (!data.loggedIn) return { auth: "none", subscriptionType: null };
    if (data.authMethod === "claude.ai" && data.apiProvider === "firstParty") {
      const subscriptionType = typeof data.subscriptionType === "string" && /^[a-z][a-z0-9_-]{0,39}$/u.test(data.subscriptionType)
        ? data.subscriptionType : null;
      return { auth: "claude-subscription", subscriptionType };
    }
    if (data.authMethod === "api_key" || data.authMethod === "api_key_helper") return { auth: "api-key", subscriptionType: null };
    return { auth: "other", subscriptionType: null };
  } finally {
    // runProcess returns only after native process-group cleanup.
    await rm(temporary, { recursive: true, force: true });
  }
}
