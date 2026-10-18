import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessRunner } from "./types.ts";

/** Hidden isolation switches and native output were reviewed against this build. */
export const CURSOR_AGENT_VERSION = "2026.07.23-e383d2b";
export type CursorAuth = "cursor-login" | "cursor-api-key";
export type CursorAccountOptions = {
  executable: string;
  auth: CursorAuth;
  apiKey?: string;
  timeoutMs?: number;
  useCurrentUserHomeForLogin?: boolean;
};
export type CursorAccountStatus = {
  auth: CursorAuth;
  credentialPresent: boolean;
  /** Native login status reports local token presence even when getMe fails. */
  verified: boolean;
};
export type CursorModel = { id: string; displayName: string; isDefault: boolean };
export type CursorAccountDeps = { runProcess?: ProcessRunner };
export class CursorMetadataTimeoutError extends Error {
  constructor() { super("Cursor Agent 元数据查询超时"); this.name = "CursorMetadataTimeoutError"; }
}

export function assertCursorAgentVersion(version: string): void {
  if (version.trim() !== CURSOR_AGENT_VERSION) {
    throw new Error(`Cursor Agent 当前仅适配 ${CURSOR_AGENT_VERSION}；请核对安装版本后再运行`);
  }
}

/** No provider endpoint substitution: these flags always address Cursor itself. */
export function cursorCommonArgs(): string[] {
  return ["--disable-auto-update", "--disable-project-configs", "--endpoint", "https://api2.cursor.sh"];
}

/**
 * Use with the clean ProcessRunner environment, never with a process.env merge.
 * macOS uses a fixed Cursor Keychain identity, but native Keychain lookup can
 * depend on the user's HOME. An explicit profile option retains that HOME for
 * native login only; configuration, data and caches still use the isolated home.
 * Other platforms' file stores cannot reuse login without exposing personal
 * files, so this adapter deliberately rejects that case.
 * API keys use the native in-memory store and never overwrite a saved login.
 */
export function cursorEnvironment(home: string, auth: CursorAuth, apiKey?: string, useCurrentUserHomeForLogin = false): Record<string, string> {
  if (!path.isAbsolute(home) || /[\u0000-\u001f\u007f]/u.test(home)) throw new Error("Cursor Agent 临时 HOME 必须是绝对路径");
  if (auth !== "cursor-login" && auth !== "cursor-api-key") throw new Error("不支持的 Cursor Agent 认证模式");
  if (auth === "cursor-login" && process.platform !== "darwin") {
    throw new Error("Cursor Agent 当前登录复用仅支持 macOS 原生 Keychain；其他平台请使用 cursor-api-key");
  }
  return {
    HOME: auth === "cursor-login" && useCurrentUserHomeForLogin ? os.homedir() : home,
    USERPROFILE: auth === "cursor-login" && useCurrentUserHomeForLogin ? os.homedir() : home,
    CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
    CURSOR_DATA_DIR: path.join(home, ".cursor-data"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    NODE_COMPILE_CACHE: path.join(home, ".cache", "cursor-compile-cache"),
    AGENT_CLI_CREDENTIAL_STORE: auth === "cursor-login" ? "default" : "memory",
    ...(auth === "cursor-api-key" && apiKey !== undefined ? { CURSOR_API_KEY: apiKey } : {}),
    CURSOR_AGENT_DISABLE_DEBUG_LOG: "1",
    DIRENV_DISABLE: "1",
    NO_OPEN_BROWSER: "1",
    NO_COLOR: "1",
    NODE_USE_ENV_PROXY: "1",
    CI: "1",
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseStatus(stdout: string): CursorAccountStatus {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("Cursor Agent 返回了无效的登录状态响应"); }
  const value = object(parsed);
  if (value === null || typeof value.isAuthenticated !== "boolean" || typeof value.hasAccessToken !== "boolean"
    || typeof value.hasRefreshToken !== "boolean") throw new Error("Cursor Agent 返回了无效的登录状态元数据");
  const authenticated = value.status === "authenticated" && value.isAuthenticated && value.hasAccessToken && value.hasRefreshToken;
  const partial = value.status === "partially-authenticated" && !value.isAuthenticated && value.hasAccessToken && !value.hasRefreshToken;
  const absent = value.status === "unauthenticated" && !value.isAuthenticated && !value.hasAccessToken && !value.hasRefreshToken;
  if (!authenticated && !partial && !absent) throw new Error("Cursor Agent 返回了不一致的登录状态元数据");
  // Native status cannot identify the original login strategy, nor verify a
  // subscription: saved API-key tokens also look like a native login here.
  return { auth: "cursor-login", credentialPresent: authenticated, verified: false };
}

/** The pinned native models command has no JSON option; parse its exact text grammar. */
function parseModels(stdout: string): CursorModel[] {
  const lines = stdout.replace(/\u001b\[[0-9;]*m/gu, "").trim().split(/\r?\n/u);
  if (lines.length === 1 && lines[0] === "No models available for this account.") return [];
  if (lines[0] !== "Available models") throw new Error("Cursor Agent 返回了无效的模型目录响应");
  const models: CursorModel[] = [];
  const seen = new Set<string>();
  let foundTip = false;
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    if (line.startsWith("Tip: use --model <id>")) { foundTip = true; continue; }
    if (foundTip || models.length >= 1000 || /[\u0000-\u001f\u007f]/u.test(line)) throw new Error("Cursor Agent 模型目录格式不受支持");
    const marker = / \((current|default|current, default)\)$/u.exec(line);
    const body = marker === null ? line : line.slice(0, marker.index);
    const delimiter = body.indexOf(" - ");
    const id = delimiter < 0 ? body : body.slice(0, delimiter);
    const displayName = delimiter < 0 ? id : body.slice(delimiter + 3);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(id) || displayName.length < 1 || displayName.length > 200 || seen.has(id)) {
      throw new Error("Cursor Agent 模型目录包含无效条目");
    }
    seen.add(id);
    models.push({ id, displayName, isDefault: marker?.[1]?.includes("default") ?? false });
  }
  if (!foundTip || models.length === 0) throw new Error("Cursor Agent 返回了不完整的模型目录响应");
  return models;
}

async function query<T>(options: CursorAccountOptions, command: "status" | "models", parse: (stdout: string) => T, deps: CursorAccountDeps): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Cursor Agent 元数据查询 timeoutMs 必须是正整数");
  if (options.executable.trim() === "" || /[\u0000-\u001f\u007f]/u.test(options.executable)) throw new Error("Cursor Agent executable 不能为空");
  if (options.auth === "cursor-api-key" && !options.apiKey?.trim()) throw new Error("Cursor Agent API key 未设置");
  const started = Date.now();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "js-llmlab-cursor-account-"));
  try {
    const home = path.join(temporary, "home");
    await mkdir(home);
    const env = cursorEnvironment(home, options.auth, options.apiKey, options.useCurrentUserHomeForLogin);
    const runner = deps.runProcess ?? runProcess;
    const run = async (args: string[], selectedEnv: Record<string, string>): Promise<string> => {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new CursorMetadataTimeoutError();
      const result = await runner({
        executable: options.executable, args, cwd: temporary, env: selectedEnv,
        timeoutMs: remaining, maxOutputBytes: 1024 * 1024, terminationGraceMs: 1000,
      }).catch(() => { throw new Error("Cursor Agent 元数据查询失败；请检查 CLI 安装与认证"); });
      if (result.timedOut || Date.now() - started >= timeoutMs) throw new CursorMetadataTimeoutError();
      if (result.error !== null || result.signal !== null || result.exitCode !== 0) {
        throw new Error("Cursor Agent 元数据查询失败；请检查 CLI 安装与认证");
      }
      return result.stdout;
    };
    // Version detection never receives API credentials or reads the Keychain.
    assertCursorAgentVersion(await run([...cursorCommonArgs(), "--version"], cursorEnvironment(home, "cursor-api-key")));
    const args = command === "status" ? ["status", "--format", "json"] : ["models"];
    return parse(await run([...cursorCommonArgs(), ...args], env));
  } finally {
    // The shared bounded runner has already reclaimed the native process group.
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Only return allowlisted fields: never identity, token values, or native diagnostics. */
export async function readCursorAccount(options: CursorAccountOptions, deps: CursorAccountDeps = {}): Promise<CursorAccountStatus> {
  if (options.auth === "cursor-api-key") {
    await query(options, "models", parseModels, deps);
    return { auth: options.auth, credentialPresent: true, verified: true };
  }
  return query(options, "status", parseStatus, deps);
}

export async function listCursorModels(options: CursorAccountOptions, deps: CursorAccountDeps = {}): Promise<CursorModel[]> {
  return query(options, "models", parseModels, deps);
}
