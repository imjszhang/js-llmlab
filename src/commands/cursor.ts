import type { Command } from "commander";
import { parseHarnessBackend, resolveTargetDefinition } from "../lib/bench/config.ts";
import { listCursorModels, readCursorAccount } from "../lib/bench/cursor-account.ts";
import type { CursorAccountOptions } from "../lib/bench/cursor-account.ts";
import { findProjectRoot } from "../lib/paths.ts";
import type { BenchCommandDeps } from "./bench.ts";

export type CursorMetadataOptions = {
  harness?: string; auth?: string; apiKeyEnv?: string; timeoutMs?: string; json?: boolean;
};

/** Query native metadata without loading .env or requesting a model completion. */
export async function runCursorMetadata(kind: "status" | "models", options: CursorMetadataOptions = {}, deps: BenchCommandDeps = {}): Promise<void> {
  const auth = options.auth ?? "cursor-login";
  if (auth !== "cursor-login" && auth !== "cursor-api-key") throw new Error("--auth 只能是 cursor-login 或 cursor-api-key");
  const timeoutMs = options.timeoutMs === undefined ? 30000 : Number(options.timeoutMs);
  if ((options.timeoutMs !== undefined && !/^\d+$/u.test(options.timeoutMs)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms 必须是 > 0 的安全整数");
  }
  const target = resolveTargetDefinition(deps.root ?? findProjectRoot(), {
    name: "cursor-metadata", kind: "harness", harness: options.harness ?? "cursor-agent",
    backend: parseHarnessBackend({ auth, model: "auto", ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }) }),
  });
  if (target.kind !== "harness" || target.profile.adapter !== "cursor-agent"
    || (target.backend.auth !== "cursor-login" && target.backend.auth !== "cursor-api-key")) {
    throw new Error("此命令需要 Cursor Agent harness profile");
  }
  const request: CursorAccountOptions = { executable: target.profile.executable, auth: target.backend.auth, timeoutMs };
  if (target.profile.useCurrentUserHomeForLogin !== undefined) request.useCurrentUserHomeForLogin = target.profile.useCurrentUserHomeForLogin;
  if (target.backend.auth === "cursor-api-key") {
    const apiKey = process.env[target.backend.apiKeyEnv];
    if (!apiKey?.trim()) throw new Error(`环境变量 ${target.backend.apiKeyEnv} 未设置；元数据查询不加载 .env`);
    request.apiKey = apiKey;
  }
  const log = deps.log ?? console.log;
  if (kind === "status") {
    const account = await readCursorAccount(request, deps);
    const safe = { auth: account.auth, credentialPresent: account.credentialPresent, verified: account.verified };
    let status: string;
    if (safe.auth === "cursor-login") {
      status = safe.credentialPresent ? "已发现原生登录凭据；账号与订阅状态尚未验证" : "未发现完整原生登录凭据";
    } else {
      status = safe.verified ? "Cursor 用户 API key 已通过模型目录验证" : "Cursor 用户 API key 尚未验证";
    }
    log(options.json === true ? JSON.stringify(safe, null, 2)
      : `Cursor Agent：${status}\n原生登录状态不证明订阅套餐或剩余额度；模型权限以 Cursor 服务执行结果为准。`);
    return;
  }
  const models = (await listCursorModels(request, deps)).map((model) => ({ id: model.id, displayName: model.displayName, isDefault: model.isDefault }));
  log(options.json === true ? JSON.stringify({ auth: request.auth, models }, null, 2)
    : ["Cursor Agent 原生模型目录（实际权限与额度以 Cursor 服务执行结果为准）", "模型\t名称\t默认",
      ...(models.length === 0 ? ["没有可用模型"] : models.map((model) => `${model.id}\t${model.displayName}\t${model.isDefault ? "是" : "-"}`)),
    ].join("\n"));
}

export function registerCursorCommands(harness: Command): void {
  const cursor = harness.command("cursor-agent").alias("cursor").description("查看 Cursor Agent 原生认证状态与模型目录");
  for (const kind of ["status", "models"] as const) {
    cursor.command(kind).description(kind === "status" ? "读取认证元数据，不显示身份或凭据" : "查询 Cursor 原生模型目录")
      .option("--harness <name>", "Cursor Agent profile", "cursor-agent")
      .option("--auth <mode>", "cursor-login 或 cursor-api-key", "cursor-login")
      .option("--api-key-env <name>", "cursor-api-key 的环境变量名称，缺省 CURSOR_API_KEY；不加载 .env")
      .option("--timeout-ms <n>", "查询时限毫秒", "30000")
      .option("--json", "输出安全元数据 JSON")
      .action((options: CursorMetadataOptions) => runCursorMetadata(kind, options));
  }
}
