import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./client.ts";
import { isAnthropicProvider, validateAnthropicChatRequest } from "./anthropic.ts";
import { getDataDir } from "./paths.ts";
import type { ConfigSnapshot, ResolvedConfig } from "../types.ts";

export type OfficialOperation =
  | "chat" | "responses" | "messages" | "fim"
  | "search" | "fetch" | "models" | "balance"
  | "files.upload" | "files.list" | "files.get" | "files.delete";

export type OfficialRequest = {
  operation: OfficialOperation;
  body?: Record<string, unknown>;
  file?: string;
  fileId?: string;
  beta?: boolean;
  anthropic?: boolean;
  headers?: Record<string, string>;
};

export type PreparedOfficialRequest = {
  operation: OfficialOperation;
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  file: { path: string; filename: string; bytes: number; mimeType: string } | null;
};

export type OfficialEvent = {
  event: string;
  id: string | null;
  data: string;
  parsed: unknown;
};

export type OfficialResult = {
  id: string;
  dir: string;
  status: number;
  response: unknown;
  events: OfficialEvent[];
  text: string;
  requestId: string | null;
};

export type OfficialFetch = (url: string, init: RequestInit) => Promise<Response>;
export type OfficialApiDeps = {
  fetch?: OfficialFetch;
  onText?: (text: string) => void;
  retryBaseDelayMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Request files carry arbitrary official fields, including complete tool conversations. */
export function readOfficialRequest(value: string): Record<string, unknown> {
  const text = value.trimStart().startsWith("{") ? value : readFileSync(path.resolve(value), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("--request 必须是 JSON 对象或包含 JSON 对象的文件");
  return parsed;
}

export function readOfficialHeaders(value: string): Record<string, string> {
  const parsed = readOfficialRequest(value);
  const result: Record<string, string> = {};
  for (const [key, field] of Object.entries(parsed)) {
    if (typeof field !== "string") throw new Error("--headers 的每个值必须是字符串");
    if (["authorization", "x-api-key", "host", "content-length", "content-type"].includes(key.toLowerCase())) {
      throw new Error(`--headers 不允许覆盖 ${key}`);
    }
    if (/\r|\n/u.test(key + field)) throw new Error("--headers 不能包含换行");
    result[key.toLowerCase()] = field;
  }
  return result;
}

function apiUrl(baseURL: string, endpoint: string): URL {
  const base = new URL(baseURL);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("API baseURL 必须为 HTTP/HTTPS");
  if (base.username !== "" || base.password !== "") throw new Error("API baseURL 不允许用户名或密码");
  let prefix = base.pathname.split("/").filter((segment) => segment !== "");
  // Only the documented official aliases are interchangeable. Gateway prefixes
  // such as /v1 or /proxy/v1 are part of that provider's configured API root.
  if (base.hostname === "api.deepseek.com" && /^(?:v1|beta|anthropic(?:\/v1)?)$/u.test(prefix.join("/"))) prefix = [];
  const suffix = endpoint.split("/").filter((segment) => segment !== "");
  let overlap = Math.min(prefix.length, suffix.length);
  while (overlap > 0 && prefix.slice(-overlap).join("/") !== suffix.slice(0, overlap).join("/")) overlap -= 1;
  base.pathname = `/${[...prefix, ...suffix.slice(overlap)].join("/")}`;
  return base;
}

function fileSegment(fileId: string | undefined): string {
  if (fileId === undefined || fileId.trim() === "") throw new Error("需要 file_id");
  if (fileId === "." || fileId === "..") throw new Error("file_id 不能是 . 或 ..");
  return encodeURIComponent(fileId);
}

function withModelDefaults(operation: OfficialOperation, body: Record<string, unknown>, config: ConfigSnapshot): Record<string, unknown> {
  if (!["chat", "responses", "messages", "fim"].includes(operation)) return body;
  const result = { ...body };
  if (result.model === undefined) result.model = config.model;
  if (operation === "responses") {
    if (result.max_output_tokens === undefined) result.max_output_tokens = config.maxTokens;
    const effort = config.thinking === "disabled" ? "none" : config.reasoningEffort ?? (config.thinking === "enabled" ? "high" : null);
    if (effort !== null && (result.reasoning === undefined || isRecord(result.reasoning))) {
      const reasoning = isRecord(result.reasoning) ? { ...result.reasoning } : {};
      if (reasoning.effort === undefined) reasoning.effort = effort;
      result.reasoning = reasoning;
    }
  } else {
    if (result.max_tokens === undefined) result.max_tokens = operation === "fim" ? Math.min(config.maxTokens, 4096) : config.maxTokens;
    if (operation !== "fim") {
      if (config.thinking !== null && result.thinking === undefined) {
        const mode = operation === "messages" && isAnthropicProvider(config) && config.thinking === "enabled"
          ? "adaptive" : config.thinking;
        result.thinking = { type: mode };
      }
      if (config.reasoningEffort !== null) {
        if (operation === "messages" && result.output_config === undefined) result.output_config = { effort: config.reasoningEffort };
        if (operation === "chat" && result.reasoning_effort === undefined) result.reasoning_effort = config.reasoningEffort;
      }
    }
  }
  return result;
}

function uploadMime(file: string): string {
  const head = Buffer.alloc(12);
  const descriptor = openSync(file, "r");
  try { readSync(descriptor, head, 0, head.length, 0); } finally { closeSync(descriptor); }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("官方 Files API 仅支持 JPEG / PNG / GIF / WebP 图片，按文件内容判断格式");
}

/** Construct a key-free preview. Unsupported fields are left for the official API to validate. */
export function prepareOfficialRequest(config: ConfigSnapshot, request: OfficialRequest): PreparedOfficialRequest {
  const op = request.operation;
  const body = withModelDefaults(op, { ...request.body }, config);
  const nativeAnthropic = isAnthropicProvider(config);
  if (op === "chat") validateAnthropicChatRequest(config, body);
  let endpoint: string;
  let method: PreparedOfficialRequest["method"] = "POST";
  let file: PreparedOfficialRequest["file"] = null;
  const anthropic = nativeAnthropic || op === "messages" || request.anthropic === true;
  const headers: Record<string, string> = { ...request.headers };
  if (anthropic) {
    headers["anthropic-version"] ??= "2023-06-01";
    if (!nativeAnthropic || op.startsWith("files.")) headers["anthropic-beta"] ??= "files-api-2025-04-14";
  }
  switch (op) {
    case "chat": endpoint = `${request.beta === true ? "/beta" : ""}/chat/completions`; break;
    case "responses": endpoint = "/responses"; break;
    case "messages": endpoint = nativeAnthropic ? "/v1/messages" : "/anthropic/v1/messages"; break;
    case "fim": endpoint = "/beta/completions"; break;
    case "search": endpoint = "/v1/tools/search"; break;
    case "fetch": endpoint = "/v1/tools/fetch"; break;
    case "models": endpoint = "/models"; method = "GET"; break;
    case "balance": endpoint = "/user/balance"; method = "GET"; break;
    case "files.upload": {
      endpoint = nativeAnthropic ? "/v1/files" : anthropic ? "/anthropic/v1/files" : "/files";
      const filename = request.file ?? (typeof body.file === "string" ? body.file : undefined);
      if (filename === undefined) throw new Error("files upload 需要文件路径或 --request 的 file 字段");
      const absolute = path.resolve(filename);
      const stat = statSync(absolute);
      if (!stat.isFile()) throw new Error("上传路径必须是文件");
      if (stat.size > 64 * 1024 * 1024) throw new Error("官方 Files API 单个图片最大 64 MiB");
      if (Buffer.byteLength(path.basename(absolute)) > 512) throw new Error("官方 Files API 文件名不能超过 512 字节");
      file = { path: absolute, filename: path.basename(absolute), bytes: stat.size, mimeType: uploadMime(absolute) };
      delete body.file;
      if (!anthropic && !nativeAnthropic && body.purpose === undefined) body.purpose = "user_data";
      break;
    }
    case "files.list": endpoint = nativeAnthropic ? "/v1/files" : anthropic ? "/anthropic/v1/files" : "/files"; method = "GET"; break;
    case "files.get": endpoint = `${nativeAnthropic ? "/v1/files" : anthropic ? "/anthropic/v1/files" : "/files"}/${fileSegment(request.fileId)}`; method = "GET"; break;
    case "files.delete": endpoint = `${nativeAnthropic ? "/v1/files" : anthropic ? "/anthropic/v1/files" : "/files"}/${fileSegment(request.fileId)}`; method = "DELETE"; break;
  }
  const url = apiUrl(config.baseURL, endpoint);
  if (method !== "POST") {
    for (const [key, value] of Object.entries(body)) {
      if (value === null || value === undefined) continue;
      url.searchParams.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  }
  return { operation: op, method, url: url.toString(), headers, body: method === "POST" ? body : null, file };
}

function appendFormField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (isRecord(value)) {
    for (const [child, field] of Object.entries(value)) appendFormField(form, `${key}[${child}]`, field);
  } else {
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
}

function requestInit(prepared: PreparedOfficialRequest, config: ResolvedConfig, signal: AbortSignal): RequestInit {
  const headers = new Headers(prepared.headers);
  if (isAnthropicProvider(config) && prepared.operation !== "chat" || prepared.operation === "messages" || prepared.url.includes("/anthropic/v1/")) headers.set("x-api-key", config.apiKey);
  else headers.set("authorization", `Bearer ${config.apiKey}`);
  const init: RequestInit = { method: prepared.method, headers, signal, redirect: "error" };
  if (prepared.file !== null) {
    const form = new FormData();
    for (const [key, value] of Object.entries(prepared.body ?? {})) appendFormField(form, key, value);
    form.append("file", new Blob([new Uint8Array(readFileSync(prepared.file.path))], { type: prepared.file.mimeType }), prepared.file.filename);
    init.body = form;
  } else if (prepared.body !== null) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(prepared.body);
  }
  return init;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => isRecord(part) && (part.type === "text" || part.type === "output_text") && typeof part.text === "string" ? part.text : "").join("");
}

export function officialResponseText(operation: OfficialOperation, response: unknown): string {
  if (!isRecord(response)) return typeof response === "string" ? response : "";
  if (operation === "chat" || operation === "fim") {
    const first: unknown = Array.isArray(response.choices) ? response.choices[0] : null;
    if (!isRecord(first)) return "";
    return typeof first.text === "string" ? first.text : isRecord(first.message) ? textFromContent(first.message.content) : "";
  }
  if (operation === "messages") return textFromContent(response.content);
  if (operation === "responses") {
    if (typeof response.output_text === "string") return response.output_text;
    return Array.isArray(response.output) ? response.output.map((item) => isRecord(item) && item.type === "message" ? textFromContent(item.content) : "").join("") : "";
  }
  if (operation === "fetch" && typeof response.content === "string") return response.content;
  return "";
}

function deltaText(operation: OfficialOperation, event: OfficialEvent): string {
  const data = event.parsed;
  if (!isRecord(data)) return "";
  if (operation === "responses") return data.type === "response.output_text.delta" && typeof data.delta === "string" ? data.delta : "";
  if (operation === "messages") return isRecord(data.delta) && data.delta.type === "text_delta" && typeof data.delta.text === "string" ? data.delta.text : "";
  const first: unknown = Array.isArray(data.choices) ? data.choices[0] : null;
  if (!isRecord(first)) return "";
  if (typeof first.text === "string") return first.text;
  return isRecord(first.delta) && typeof first.delta.content === "string" ? first.delta.content : "";
}

function parseEvent(block: string): OfficialEvent | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const joined = data.join("\n");
  return { event, id, data: joined, parsed: joined === "[DONE]" ? null : parseJson(joined) };
}

function semanticError(response: unknown, events: OfficialEvent[]): string | null {
  if (isRecord(response) && response.error !== undefined && response.error !== null) return JSON.stringify(response.error);
  const finishError = (value: unknown): string | null => {
    if (!isRecord(value) || !Array.isArray(value.choices)) return null;
    const interrupted: unknown = value.choices.find((choice: unknown) => isRecord(choice) && ["aborted", "insufficient_system_resource", "content_filter"].includes(String(choice.finish_reason)));
    return isRecord(interrupted) ? `模型生成未完成：finish_reason=${String(interrupted.finish_reason)}` : null;
  };
  const interrupted = finishError(response);
  if (interrupted !== null) return interrupted;
  const failed = events.find((event) => ["error", "response.failed"].includes(event.event) || isRecord(event.parsed) && (event.parsed.type === "error" || event.parsed.type === "response.failed" || event.parsed.error !== undefined));
  if (failed !== undefined) return failed.data;
  for (const event of events) {
    const error = finishError(event.parsed);
    if (error !== null) return error;
  }
  return null;
}

async function responseText(response: Response, signal: AbortSignal, capture: (chunk: string) => void): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const onAbort = (): void => { void reader.cancel(signal.reason); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      const decoded = decoder.decode(chunk.value, { stream: !chunk.done });
      text += decoded;
      capture(decoded);
      if (chunk.done) return text;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Transport logs all SSE events, including usage, tools, reasoning and terminal errors. */
export async function executeOfficialRequest(root: string, config: ResolvedConfig, prepared: PreparedOfficialRequest, deps: OfficialApiDeps = {}): Promise<OfficialResult> {
  const id = `api_${randomBytes(8).toString("hex")}`;
  const dir = path.join(getDataDir(root), "api", id);
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();
  const secret = [config.apiKey];
  const safe = (value: string): string => redactSecrets(value, secret);
  const writeJson = (filename: string, value: unknown): void => { writeFileSync(path.join(dir, filename), `${safe(JSON.stringify(value, null, 2))}\n`, "utf8"); };
  mkdirSync(dir, { recursive: true });
  writeJson("request.json", prepared);
  const events: OfficialEvent[] = [];
  let responseValue: unknown = null;
  let responseRaw = "";
  let text = "";
  let status = 0;
  let requestId: string | null = null;
  let attempts = 0;
  let errorText: string | null = null;
  let pendingOutput = "";
  const emit = (value: string): void => {
    text += value;
    // Hold a key-sized tail so even a credential split across SSE deltas cannot leak.
    pendingOutput = safe(pendingOutput + value);
    const ready = Math.max(0, pendingOutput.length - Math.max(0, config.apiKey.length - 1));
    if (ready > 0) { deps.onText?.(pendingOutput.slice(0, ready)); pendingOutput = pendingOutput.slice(ready); }
  };
  try {
    for (;;) {
      attempts += 1;
      responseValue = null;
      responseRaw = "";
      status = 0;
      requestId = null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`请求超过 ${String(config.timeoutMs)} ms`)), config.timeoutMs);
      let retry = false;
      try {
        const response = await (deps.fetch ?? fetch)(prepared.url, requestInit(prepared, config, controller.signal));
        status = response.status;
        requestId = response.headers.get("x-oneapi-request-id") ?? response.headers.get("x-request-id") ?? response.headers.get("request-id");
        if (!response.ok) {
          await responseText(response, controller.signal, (chunk) => { responseRaw += chunk; });
          responseValue = parseJson(responseRaw);
          const retryable = status === 408 || status === 429 || status >= 500;
          retry = prepared.operation !== "files.upload" && retryable && attempts <= config.maxRetries;
          writeJson(`attempt-${String(attempts)}.json`, { status, requestId, response: responseValue });
          if (!retry) throw new Error(`HTTP ${String(status)}: ${responseRaw}`);
        } else if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          if (response.body === null) throw new Error("SSE 响应没有 body");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let pendingCR = false;
          const accept = (block: string): void => {
            const event = parseEvent(block);
            if (event === null) return;
            events.push(event);
            if (isRecord(event.parsed) && isRecord(event.parsed.response)) responseValue = event.parsed.response;
            emit(deltaText(prepared.operation, event));
          };
          const normalize = (chunk: string, final: boolean): string => {
            let value = pendingCR ? `\r${chunk}` : chunk;
            pendingCR = !final && value.endsWith("\r");
            if (pendingCR) value = value.slice(0, -1);
            return value.replace(/\r\n|\r/gu, "\n");
          };
          const onAbort = (): void => { void reader.cancel(controller.signal.reason); };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          try {
            for (;;) {
              const chunk = await reader.read();
              controller.signal.throwIfAborted();
              const decoded = decoder.decode(chunk.value, { stream: !chunk.done });
              responseRaw += decoded;
              buffer += normalize(decoded, chunk.done);
              let boundary: number;
              while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                accept(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
              }
              if (chunk.done) { if (buffer !== "") accept(buffer); break; }
            }
          } finally {
            controller.signal.removeEventListener("abort", onAbort);
            reader.releaseLock();
          }
          const failure = semanticError(responseValue, events);
          if (failure !== null) throw new Error(`API 流式错误：${failure}`);
          const complete = events.some((event) => event.data === "[DONE]" || event.event === "message_stop" || isRecord(event.parsed) && ["message_stop", "response.completed", "response.incomplete"].includes(String(event.parsed.type)));
          if (!complete) throw new Error("SSE 在完成事件前结束，已保存收到的全部事件");
          if (text === "") emit(officialResponseText(prepared.operation, responseValue));
        } else {
          await responseText(response, controller.signal, (chunk) => { responseRaw += chunk; });
          try { responseValue = JSON.parse(responseRaw); }
          catch { throw new Error("API 返回了非 JSON 响应，原文已保存"); }
          const failure = semanticError(responseValue, events);
          if (failure !== null) throw new Error(`API 错误：${failure}`);
          text = officialResponseText(prepared.operation, responseValue);
        }
      } finally { clearTimeout(timeout); }
      if (!retry) break;
      const delay = (deps.retryBaseDelayMs ?? 1000) * 2 ** (attempts - 1);
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    if (pendingOutput !== "") deps.onText?.(safe(pendingOutput));
  } catch (error) {
    errorText = safe(error instanceof Error ? error.message : String(error));
    throw new Error(`${errorText}（记录：${dir}）`);
  } finally {
    writeJson("response.json", responseValue);
    writeJson("events.json", events);
    writeFileSync(path.join(dir, "response.txt"), safe(responseRaw), "utf8");
    writeJson("meta.json", { id, operation: prepared.operation, createdAt, status, requestId, attempts, latencyMs: Date.now() - startedAt, error: errorText });
  }
  return { id, dir, status, response: parseJson(safe(JSON.stringify(responseValue))), events: events.map((event) => ({ ...event, event: safe(event.event), id: event.id === null ? null : safe(event.id), data: safe(event.data), parsed: parseJson(safe(JSON.stringify(event.parsed))) })), text: safe(text), requestId: requestId === null ? null : safe(requestId) };
}
