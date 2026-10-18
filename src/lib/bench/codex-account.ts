import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.ts";
import type { ProcessRunner } from "./types.ts";

export type CodexAccountStatus = { auth: "chatgpt" | "api-key" | "none" | "other"; planType: string | null };
export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  inputModalities: string[];
};
export type CodexAccountOptions = {
  executable: string;
  codexHome: string;
  credentialsStore?: "auto" | "file" | "keyring";
  timeoutMs?: number;
  includeHidden?: boolean;
};
export type CodexAccountDeps = { runProcess?: ProcessRunner };
export class CodexMetadataTimeoutError extends Error {
  constructor() { super("Codex 元数据查询超时"); this.name = "CodexMetadataTimeoutError"; }
}
/** Native transport settings only; callers must redact values before recording a process plan. */
export function codexNetworkEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/*
 * A trusted stdio bridge keeps interactive JSON-RPC inside the existing bounded
 * process runner. It never starts a thread, logs in, refreshes auth explicitly,
 * or forwards native diagnostics/unknown response fields into lab records.
 * The native child stays in the bridge's process group for timeout cleanup.
 */
const METADATA_BRIDGE = String.raw`
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const options = JSON.parse(input);
const child = spawn(options.executable, options.args, { cwd: process.cwd(), env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let nextId = 1;
let bytes = 0;
let closed = false;
let failure = null;
let closing;
const closePromise = new Promise(resolve => { closing = resolve; });
let shutdownPromise;
const shutdown = () => shutdownPromise ??= (async () => {
  child.stdin.end();
  if (!closed) child.kill("SIGTERM");
  const timer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 200);
  await closePromise;
  clearTimeout(timer);
})();
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(143)); });
process.once("SIGINT", () => { void shutdown().then(() => process.exit(130)); });
const fail = message => {
  failure ??= new Error(message);
  for (const entry of pending.values()) entry.reject(failure);
  pending.clear();
};
const count = chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 4 * 1024 * 1024) { fail("Codex metadata exceeded the output limit"); child.kill("SIGTERM"); }
};
child.stdout.on("data", count);
child.stderr.on("data", count);
child.on("error", () => fail("Unable to start Codex metadata process"));
child.on("close", () => { closed = true; fail("Codex metadata process ended before completing the request"); closing(); });
child.stdin.on("error", () => fail("Unable to write Codex metadata request"));
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  if (line.trim() === "") return;
  let value;
  try { value = JSON.parse(line); } catch { fail("Codex emitted invalid metadata JSON"); return; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) { fail("Codex emitted invalid metadata response"); return; }
  // Notifications are not account data. Server requests are never approved.
  if (typeof value.method === "string") {
    if (value.id !== undefined) child.stdin.write(JSON.stringify({id:value.id,error:{code:-32601,message:"This client only reads account and model metadata"}})+"\n");
    return;
  }
  const entry = pending.get(value.id);
  if (entry === undefined) { fail("Codex returned an unexpected metadata response"); return; }
  pending.delete(value.id);
  if (value.error !== undefined) entry.reject(new Error("Codex rejected the " + entry.method + " metadata request"));
  else if (!("result" in value)) entry.reject(new Error("Codex metadata response has no result"));
  else entry.resolve(value.result);
});
const request = (method, params) => {
  if (failure !== null) return Promise.reject(failure);
  const id = nextId++;
  return new Promise((resolve,reject) => {
    pending.set(id,{resolve,reject,method});
    child.stdin.write(JSON.stringify({id,method,params})+"\n");
  });
};
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max=2000) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const model = value => {
  if (!object(value) || !text(value.id,256) || !text(value.model,256) || value.model.trim() === ""
    || !text(value.displayName,500) || !text(value.description) || typeof value.hidden !== "boolean"
    || typeof value.isDefault !== "boolean" || !text(value.defaultReasoningEffort,80)
    || !Array.isArray(value.supportedReasoningEfforts)) throw new Error("Codex returned invalid model metadata");
  const efforts = value.supportedReasoningEfforts.map(item => {
    if (!object(item) || !text(item.reasoningEffort,80) || item.reasoningEffort.trim() === "") throw new Error("Codex returned invalid model effort metadata");
    return item.reasoningEffort;
  });
  const modalities = value.inputModalities ?? ["text","image"];
  if (!Array.isArray(modalities) || !modalities.every(item => text(item,80))) throw new Error("Codex returned invalid model modality metadata");
  return {id:value.id,model:value.model,displayName:value.displayName,description:value.description,
    hidden:value.hidden,isDefault:value.isDefault,defaultReasoningEffort:value.defaultReasoningEffort,
    supportedReasoningEfforts:[...new Set(efforts)],inputModalities:modalities};
};
let result;
try {
  await request("initialize", {clientInfo:{name:"js_llmlab",title:"js-llmlab",version:"1.0.0"},capabilities:{experimentalApi:false}});
  child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
  const status = options.account;
  const models = [];
  if (options.models && status.auth === "chatgpt") {
    const cursors = new Set();
    const ids = new Set();
    let cursor;
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error("Codex model pagination exceeded the limit");
      const value = await request("model/list",{limit:100,includeHidden:options.includeHidden,...(cursor === undefined ? {} : {cursor})});
      if (!object(value) || !Array.isArray(value.data)) throw new Error("Codex returned invalid model list metadata");
      for (const item of value.data) {
        const parsed = model(item);
        if (ids.has(parsed.id)) throw new Error("Codex returned duplicate model metadata");
        ids.add(parsed.id);
        models.push(parsed);
        if (models.length > 10000) throw new Error("Codex model list exceeded the limit");
      }
      if (value.nextCursor == null) break;
      if (!text(value.nextCursor,4096) || cursors.has(value.nextCursor)) throw new Error("Codex returned invalid model pagination");
      cursor = value.nextCursor;
      cursors.add(cursor);
    }
  }
  result = {account:status,models};
} catch (error) {
  result = {error: error instanceof Error ? error.message : "Codex metadata query failed"};
} finally {
  await shutdown();
  lines.close();
}
process.stdout.write(JSON.stringify(result)+"\n");
`;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeText(value: unknown, max = 2000): value is string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function parseStatus(value: unknown): CodexAccountStatus {
  const item = object(value);
  if (item === null || (item.auth !== "chatgpt" && item.auth !== "api-key" && item.auth !== "none" && item.auth !== "other")
    || (item.planType !== null && !safeText(item.planType, 80))) throw new Error("Codex 返回了无效的账户元数据");
  return { auth: item.auth, planType: item.planType };
}
function parseModel(value: unknown): CodexModel {
  const item = object(value);
  if (item === null || !safeText(item.id, 256) || !safeText(item.model, 256) || item.model.trim() === ""
    || !safeText(item.displayName, 500) || !safeText(item.description) || typeof item.hidden !== "boolean" || typeof item.isDefault !== "boolean"
    || !safeText(item.defaultReasoningEffort, 80) || !Array.isArray(item.supportedReasoningEfforts)
    || !item.supportedReasoningEfforts.every((entry: unknown): entry is string => safeText(entry, 80) && entry.trim() !== "")
    || !Array.isArray(item.inputModalities) || !item.inputModalities.every((entry: unknown): entry is string => safeText(entry, 80))) {
    throw new Error("Codex 返回了无效的模型元数据");
  }
  return {
    id: item.id, model: item.model, displayName: item.displayName, description: item.description,
    hidden: item.hidden, isDefault: item.isDefault, defaultReasoningEffort: item.defaultReasoningEffort,
    supportedReasoningEfforts: [...item.supportedReasoningEfforts], inputModalities: [...item.inputModalities],
  };
}

/**
 * Native app-server has no --ignore-user-config. A fresh provider key prevents
 * personal provider auth commands or endpoint overrides from being inherited.
 * Machine requirements still apply. No thread or tools are started; temporary
 * HOME/state/log directories are removed after the child has been reaped.
 */
async function inspect(options: CodexAccountOptions, models: boolean, deps: CodexAccountDeps): Promise<{ account: CodexAccountStatus; models: CodexModel[] }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Codex 元数据查询 timeoutMs 必须是正整数");
  if (!path.isAbsolute(options.codexHome) || options.codexHome.includes("\0")) throw new Error("Codex 登录目录必须是绝对路径");
  if (options.executable.trim() === "" || options.executable.includes("\0")) throw new Error("Codex executable 不能为空");
  const store = options.credentialsStore ?? "auto";
  if (store !== "auto" && store !== "file" && store !== "keyring") throw new Error("不支持的 Codex 凭据存储模式");
  const started = Date.now();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "js-llmlab-codex-account-"));
  try {
    const home = path.join(temporary, "home");
    const state = path.join(temporary, "state");
    await Promise.all([mkdir(home), mkdir(state)]);
    const provider = `js_llmlab_metadata_${randomUUID().replaceAll("-", "")}`;
    const config: Record<string, string | boolean | number> = {
      model_provider: provider,
      [`model_providers.${provider}.name`]: "OpenAI",
      [`model_providers.${provider}.base_url`]: "https://chatgpt.com/backend-api/codex",
      [`model_providers.${provider}.model_catalog_url`]: "https://chatgpt.com/backend-api/codex/models",
      [`model_providers.${provider}.wire_api`]: "responses",
      [`model_providers.${provider}.requires_openai_auth`]: true,
      openai_base_url: "https://api.openai.com/v1",
      chatgpt_base_url: "https://chatgpt.com/backend-api/",
      cli_auth_credentials_store: store,
      sqlite_home: state,
      log_dir: path.join(temporary, "log"),
      project_doc_max_bytes: 0,
      check_for_update_on_startup: false,
      "features.plugins": false,
      "features.apps": false,
      "features.hooks": false,
      "features.skip_host_skill_discovery": true,
      "features.skill_search": false,
      "features.skill_mcp_dependency_install": false,
      "analytics.enabled": false,
      "otel.log_user_prompt": false,
      "otel.exporter": "none",
    };
    const configArgs: string[] = [];
    for (const [key, value] of Object.entries(config)) configArgs.push("-c", `${key}=${JSON.stringify(value)}`);
    configArgs.push("-c", "mcp_servers={}");
    const env: Record<string, string> = {
        HOME: home, USERPROFILE: home, CODEX_HOME: options.codexHome, CODEX_SQLITE_HOME: state,
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"),
        NO_COLOR: "1", RUST_LOG: "error",
    };
    // These host transport settings may be required to reach ChatGPT. They are
    // passed only to native processes, never exported in the metadata result.
    Object.assign(env, codexNetworkEnvironment());
    const remaining = (): number => {
      const value = timeoutMs - (Date.now() - started);
      if (value <= 0) throw new CodexMetadataTimeoutError();
      return value;
    };
    const runner = deps.runProcess ?? runProcess;
    const statusResult = await runner({
      executable: options.executable, args: ["--no-daemon", "login", "status", ...configArgs], cwd: temporary, env,
      timeoutMs: remaining(), maxOutputBytes: 16 * 1024,
    });
    if (statusResult.timedOut) throw new CodexMetadataTimeoutError();
    if (statusResult.error !== null) throw new Error("Codex 登录状态查询失败；请检查 CLI 安装与本机配置");
    const statusText = `${statusResult.stdout}\n${statusResult.stderr}`;
    let account: CodexAccountStatus;
    if (statusResult.exitCode === 0 && /^Logged in using ChatGPT\s*$/mu.test(statusText)) account = { auth: "chatgpt", planType: null };
    else if (statusResult.exitCode === 0 && /^Logged in using (?:an? )?API key\b/imu.test(statusText)) account = { auth: "api-key", planType: null };
    else if (/^Not logged in\.?\s*$/imu.test(statusText)) account = { auth: "none", planType: null };
    else throw new Error("无法识别 Codex 登录状态；请检查 CLI 版本与登录状态");
    if (!models || account.auth !== "chatgpt") return { account, models: [] };
    const args = ["--no-daemon", "app-server", "--stdio", ...configArgs];
    const result = await runner({
      executable: process.execPath,
      args: ["--input-type=module", "-e", METADATA_BRIDGE],
      cwd: temporary,
      env,
      stdin: JSON.stringify({ executable: options.executable, args, account, models, includeHidden: options.includeHidden ?? false }),
      timeoutMs: remaining(),
      maxOutputBytes: 4 * 1024 * 1024,
      terminationGraceMs: 500,
    });
    if (result.timedOut) throw new CodexMetadataTimeoutError();
    // Native stderr may contain a personal route or credential. Never surface it.
    if (result.error !== null || result.exitCode !== 0) throw new Error("Codex 元数据查询失败；请检查 CLI 安装、登录状态与本机配置");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Codex 返回了无效的元数据响应"); }
    const data = object(parsed);
    if (data === null || data.error !== undefined) throw new Error("Codex 元数据查询失败；请检查 CLI 登录状态与本机配置");
    const reportedAccount = parseStatus(data.account);
    if (reportedAccount.auth !== account.auth || reportedAccount.planType !== account.planType) throw new Error("Codex 模型查询的登录状态不一致");
    if (!Array.isArray(data.models)) throw new Error("Codex 返回了无效的模型列表");
    return { account, models: data.models.map(parseModel) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Read native login metadata without inference, token export or explicit refresh. */
export async function readCodexAccount(options: CodexAccountOptions, deps: CodexAccountDeps = {}): Promise<CodexAccountStatus> {
  return (await inspect(options, false, deps)).account;
}

/** Discover the current ChatGPT account's model catalog; no fixed model aliases. */
export async function listCodexModels(options: CodexAccountOptions, deps: CodexAccountDeps = {}): Promise<{ account: CodexAccountStatus; models: CodexModel[] }> {
  return inspect(options, true, deps);
}
