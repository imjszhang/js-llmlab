import type { Command } from "commander";
import { redactSecrets } from "../lib/client.ts";
import {
  loadEnv,
  parseMaxRetries,
  parseTimeoutMs,
  peekConfig,
  peekConfigRef,
  resolveConfig,
  resolveConfigRef,
} from "../lib/config.ts";
import {
  executeOfficialRequest,
  prepareOfficialRequest,
  readOfficialHeaders,
  readOfficialRequest,
} from "../lib/official-api.ts";
import type { OfficialApiDeps, OfficialOperation, OfficialRequest, OfficialResult } from "../lib/official-api.ts";
import { findProjectRoot } from "../lib/paths.ts";
import type { CliConfigOverrides } from "../types.ts";

export type OfficialCommandDeps = OfficialApiDeps & {
  root?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  return typeof options[key] === "string" ? options[key] : undefined;
}

function addOfficialOptions(command: Command): Command {
  return command
    .option("--request <json>", "原始请求 JSON 文件或内联 JSON，保留全部协议字段")
    .option("--config <name>", "命名配置或模型 id；不指定时使用官方 deepseek provider")
    .option("--provider <name>", "覆盖 provider")
    .option("--model <id>", "显式覆盖请求的模型")
    .option("--headers <json>", "额外请求头 JSON 文件或内联 JSON，不可覆盖认证")
    .option("--timeout-ms <n>", "请求总超时毫秒，包含读取流")
    .option("--max-retries <n>", "408/429/5xx 最大重试数；文件上传不重试")
    .option("--dry-run", "打印无密钥请求，不访问网络、不落盘")
    .option("--json", "输出原始响应 JSON；流式时包含全部 SSE 事件");
}

export async function runOfficial(
  operation: OfficialOperation,
  options: Record<string, unknown>,
  extra: { query?: string; url?: string; file?: string; fileId?: string } = {},
  deps: OfficialCommandDeps = {},
): Promise<OfficialResult | null> {
  const root = deps.root ?? findProjectRoot();
  loadEnv(root);
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const configName = stringOption(options, "config");
  const provider = stringOption(options, "provider") ?? (configName === undefined ? "deepseek" : undefined);
  const model = stringOption(options, "model");
  const overrides: CliConfigOverrides = {};
  if (provider !== undefined) overrides.provider = provider;
  if (model !== undefined) overrides.model = model;
  const timeoutMs = parseTimeoutMs(options.timeoutMs);
  const maxRetries = parseMaxRetries(options.maxRetries);
  if (timeoutMs !== undefined) overrides.timeoutMs = timeoutMs;
  if (maxRetries !== undefined) overrides.maxRetries = maxRetries;
  const peek = configName === undefined ? peekConfig(root, undefined, overrides) : peekConfigRef(root, configName, overrides);
  const requestJson = stringOption(options, "request");
  const body = requestJson === undefined ? {} : readOfficialRequest(requestJson);
  if (["chat", "responses", "messages", "fim"].includes(operation) && requestJson === undefined) throw new Error("api 命令需要 --request <JSON文件或内联JSON>");
  if (extra.query !== undefined) body.query = extra.query;
  if (extra.url !== undefined) body.url = extra.url;
  if (operation === "search" && (typeof body.query !== "string" || body.query.trim() === "")) throw new Error("search 需要 query 参数或 --request 的 query 字段");
  if (operation === "fetch" && (typeof body.url !== "string" || body.url.trim() === "")) throw new Error("fetch 需要 URL 参数或 --request 的 url 字段");
  if (model !== undefined) body.model = model;
  if (options.stream === true) body.stream = true;
  const request: OfficialRequest = { operation, body };
  if (extra.file !== undefined) request.file = extra.file;
  if (extra.fileId !== undefined) request.fileId = extra.fileId;
  if (options.beta === true) request.beta = true;
  if (options.anthropic === true) request.anthropic = true;
  const headers = stringOption(options, "headers");
  if (headers !== undefined) request.headers = readOfficialHeaders(headers);
  const prepared = prepareOfficialRequest(peek.snapshot, request);
  if (options.dryRun === true) {
    stdout(`${redactSecrets(JSON.stringify({ config: peek.snapshot, request: prepared }, null, 2), [process.env[peek.apiKeyEnv] ?? ""])}\n`);
    return null;
  }
  const config = configName === undefined ? resolveConfig(root, undefined, overrides) : resolveConfigRef(root, configName, overrides);
  const transport: OfficialApiDeps = {};
  if (deps.fetch !== undefined) transport.fetch = deps.fetch;
  if (deps.retryBaseDelayMs !== undefined) transport.retryBaseDelayMs = deps.retryBaseDelayMs;
  let streamed = false;
  if (options.json !== true) {
    transport.onText = (text: string): void => { streamed = true; stdout(text); };
  }
  const result = await executeOfficialRequest(root, config, prepared, transport);
  if (options.json === true) stdout(`${JSON.stringify(result.events.length > 0 ? { response: result.response, events: result.events } : result.response, null, 2)}\n`);
  else if (streamed) stdout("\n");
  else if (result.text !== "") stdout(`${result.text}\n`);
  else stdout(`${JSON.stringify(result.events.length > 0 ? { response: result.response, events: result.events } : result.response, null, 2)}\n`);
  stderr(`记录：${result.dir}\n`);
  return result;
}

/** Raw protocol entry points deliberately never execute returned function or shell tools. */
export function registerOfficialCommands(program: Command, deps: OfficialCommandDeps = {}): void {
  const api = program.command("api").description("原样调用模型 API（JSON 请求；保留工具、图片及所有高级字段）");
  const operations: Array<{ name: "chat" | "responses" | "messages" | "fim"; description: string }> = [
    { name: "chat", description: "Chat Completions；--beta 支持前缀续写/strict tools" },
    { name: "responses", description: "Responses API（无状态，完整历史放 input）" },
    { name: "messages", description: "Anthropic 兼容 Messages" },
    { name: "fim", description: "Beta FIM 中间补全（仅非思考，最长 4K）" },
  ];
  for (const operation of operations) {
    const command = addOfficialOptions(api.command(operation.name).description(operation.description)).option("--stream", "以 SSE 流输出正文，保存全部事件");
    if (operation.name === "chat") command.option("--beta", "使用 /beta/chat/completions");
    command.action(async (options: Record<string, unknown>) => { await runOfficial(operation.name, options, {}, deps); });
  }
  const deepseek = program.command("deepseek").description("官方搜索、网页抓取、Files、余额与模型列表");
  addOfficialOptions(deepseek.command("search [query]").description("调用官方 Search；--request 可传 count/need_content 等"))
    .action(async (query: string | undefined, options: Record<string, unknown>) => { await runOfficial("search", options, query === undefined ? {} : { query }, deps); });
  addOfficialOptions(deepseek.command("fetch [url]").description("抓取单页 Markdown"))
    .action(async (url: string | undefined, options: Record<string, unknown>) => { await runOfficial("fetch", options, url === undefined ? {} : { url }, deps); });
  for (const operation of ["models", "balance"] satisfies OfficialOperation[]) {
    addOfficialOptions(deepseek.command(operation).description(operation === "models" ? "官方模型列表" : "账户余额"))
      .action(async (options: Record<string, unknown>) => { await runOfficial(operation, options, {}, deps); });
  }
  const files = deepseek.command("files").description("官方图片文件（JPEG/PNG/GIF/WebP，最大 64 MiB）");
  addOfficialOptions(files.command("upload [file]").description("上传图片；--request 支持 expires_after 等表单字段"))
    .option("--anthropic", "使用 Anthropic 兼容 Files 格式")
    .action(async (file: string | undefined, options: Record<string, unknown>) => { await runOfficial("files.upload", options, file === undefined ? {} : { file }, deps); });
  addOfficialOptions(files.command("list").description("文件列表；分页游标等用 --request 传入"))
    .option("--anthropic", "使用 Anthropic 兼容 Files 格式")
    .action(async (options: Record<string, unknown>) => { await runOfficial("files.list", options, {}, deps); });
  for (const operation of ["get", "delete"] satisfies Array<"get" | "delete">) {
    addOfficialOptions(files.command(`${operation} <file_id>`).description(operation === "get" ? "查询文件信息" : "删除指定文件"))
      .option("--anthropic", "使用 Anthropic 兼容 Files 格式")
      .action(async (fileId: string, options: Record<string, unknown>) => { await runOfficial(`files.${operation}`, options, { fileId }, deps); });
  }
}
