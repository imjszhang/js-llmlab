import OpenAI from "openai";
import type {
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { ChatMessage, ConfigSnapshot, RawCapture, ResolvedConfig, TokenUsage } from "../types.ts";

export type CompletionResult = {
  text: string;
  reasoning: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
  /** 响应头 `x-request-id`，网关不给就是 null。 */
  requestId: string | null;
  /** 原始请求 / 响应，落 `nodes/<id>.raw.json`；假 completer 可以不给。 */
  raw: RawCapture | null;
};

export type CompletionOptions = {
  stream?: boolean;
  onDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
};

/**
 * 发一次补全的函数签名。`runCompletion` 是真实实现；测试里注入假实现，
 * 让 run / compare 的编排逻辑可以离线验证。
 */
export type Completer = (
  config: ResolvedConfig,
  messages: ChatMessage[],
  options?: CompletionOptions,
) => Promise<CompletionResult>;

export function createClient(config: ResolvedConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    // 重试在 withRetries 里做，SDK 自己的关掉，避免双重重试。
    maxRetries: 0,
  });
}

export const DEFAULT_RETRY_BASE_MS = 1000;

export type RetryOptions = {
  /** 第 k 次重试前等 baseDelayMs × 2^(k-1)；测试传 0。缺省 1000。 */
  baseDelayMs?: number;
  /** 每次重试前回调，用来打日志。 */
  onRetry?: (info: { config: ResolvedConfig; attempt: number; maxRetries: number; error: unknown }) => void;
  /** 可注入的 sleep，缺省 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 给任意 completer 加指数退避重试，次数取 `config.maxRetries`。
 * 流式一旦已经吐出内容就不再重试（否则终端会重复打印），直接把错误抛给调用方。
 */
export function withRetries(complete: Completer, options: RetryOptions = {}): Completer {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = options.sleep ?? defaultSleep;
  return async (config, messages, completionOptions = {}) => {
    let streamed = false;
    const guarded: CompletionOptions = { ...completionOptions };
    if (completionOptions.onDelta !== undefined) {
      const inner = completionOptions.onDelta;
      guarded.onDelta = (chunk) => {
        streamed = true;
        inner(chunk);
      };
    }
    if (completionOptions.onReasoningDelta !== undefined) {
      const inner = completionOptions.onReasoningDelta;
      guarded.onReasoningDelta = (chunk) => {
        streamed = true;
        inner(chunk);
      };
    }
    let attempt = 0;
    for (;;) {
      try {
        return await complete(config, messages, guarded);
      } catch (error) {
        if (streamed || attempt >= config.maxRetries) {
          throw error;
        }
        attempt += 1;
        options.onRetry?.({ config, attempt, maxRetries: config.maxRetries, error });
        const delay = baseDelayMs * 2 ** (attempt - 1);
        if (delay > 0) {
          await sleep(delay);
        }
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: string[]): string {
  if (!isRecord(value)) {
    return "";
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field !== "") {
      return field;
    }
  }
  return "";
}

function mapUsage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) {
    return null;
  }
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null;
  const reasoningRaw = details?.reasoning_tokens ?? usage.reasoning_tokens;
  return {
    promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    reasoningTokens: typeof reasoningRaw === "number" ? reasoningRaw : null,
  };
}

/**
 * 组装 chat.completions 请求体。只依赖配置快照，不含密钥，
 * 所以 `--dry-run` 可以直接打印它。
 */
export function buildChatRequest(
  config: ConfigSnapshot,
  messages: ChatMessage[],
  stream: boolean,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    messages,
  };
  if (config.reasoningEffort !== null) {
    params.reasoning_effort = config.reasoningEffort;
  }
  if (config.thinking !== null) {
    params.thinking = { type: config.thinking };
  }
  if (stream) {
    params.stream = true;
    params.stream_options = { include_usage: true };
  }
  return params;
}

/** 按优先级找 request id：标准头之外，llmcore（one-api 系）用 `x-oneapi-request-id`。 */
export const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-oneapi-request-id",
  "x-keybalancer-request-id",
  "request-id",
  "cf-ray",
] as const;

export function requestIdFromHeaders(headers: Headers | Record<string, unknown> | undefined): string | null {
  if (headers === undefined) {
    return null;
  }
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers instanceof Headers ? headers.get(name) : headers[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

/** 响应头里所有像 id 的（request / trace / ray），落 raw 文件方便对账；不会碰请求头。 */
export function idLikeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (/request|trace|ray/iu.test(name)) {
      out[name] = value;
    }
  });
  return out;
}

/**
 * 全仓库唯一的类型绕过点。
 *
 * `buildChatRequest` 为了让 `--dry-run` 能原样打印，返回宽松的 Record；
 * 而且请求体里带 SDK 类型没有的网关扩展字段（DeepSeek 的 `thinking`），
 * 本来也不可能通过 `ChatCompletionCreateParams` 的结构检查。
 * 这里按 stream 分流成 SDK 的两种参数类型，其余代码只跟带类型的响应打交道。
 */
function toSdkParams(request: Record<string, unknown>, stream: true): ChatCompletionCreateParamsStreaming;
function toSdkParams(request: Record<string, unknown>, stream: false): ChatCompletionCreateParamsNonStreaming;
function toSdkParams(request: Record<string, unknown>, _stream: boolean): ChatCompletionCreateParams {
  return request as never;
}

export async function runCompletion(
  config: ResolvedConfig,
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const client = createClient(config);
  const started = Date.now();
  const stream = options.stream === true;

  if (stream) {
    const request = buildChatRequest(config, messages, true);
    const { data: response, response: http } = await client.chat.completions
      .create(toSdkParams(request, true))
      .withResponse();
    const requestId = requestIdFromHeaders(http.headers);

    let text = "";
    let reasoning = "";
    let usage: TokenUsage | null = null;
    let rawUsage: unknown = null;
    let chunkCount = 0;
    let first: Record<string, unknown> | null = null;
    let finishReason: string | null = null;
    for await (const chunk of response) {
      chunkCount += 1;
      if (first === null) {
        first = { ...chunk };
      }
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      const content = readStringField(delta, ["content"]);
      if (content !== "") {
        text += content;
        options.onDelta?.(content);
      }
      const think = readStringField(delta, ["reasoning_content", "reasoning", "thinking"]);
      if (think !== "") {
        reasoning += think;
        options.onReasoningDelta?.(think);
      }
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const mapped = mapUsage(chunk.usage);
      if (mapped !== null) {
        usage = mapped;
        rawUsage = chunk.usage;
      }
    }
    // 流式没有「完整响应对象」，按非流式的形状拼一个，方便对照。
    const assembled: Record<string, unknown> = {
      id: first?.id ?? null,
      object: "chat.completion",
      created: first?.created ?? null,
      model: first?.model ?? null,
      system_fingerprint: first?.system_fingerprint ?? null,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text,
            reasoning_content: reasoning === "" ? null : reasoning,
          },
          finish_reason: finishReason,
        },
      ],
      usage: rawUsage,
    };
    return {
      text,
      reasoning: reasoning === "" ? null : reasoning,
      usage,
      latencyMs: Date.now() - started,
      requestId,
      raw: {
        request,
        response: assembled,
        chunkCount,
        requestId,
        systemFingerprint: typeof first?.system_fingerprint === "string" ? first.system_fingerprint : null,
        headers: idLikeHeaders(http.headers),
        error: null,
      },
    };
  }

  const request = buildChatRequest(config, messages, false);
  const { data: response, response: http } = await client.chat.completions
    .create(toSdkParams(request, false))
    .withResponse();
  const requestId = requestIdFromHeaders(http.headers);
  const message = response.choices[0]?.message;
  const text = readStringField(message, ["content"]);
  const reasoning = readStringField(message, ["reasoning_content", "reasoning", "thinking"]);
  return {
    text,
    reasoning: reasoning === "" ? null : reasoning,
    usage: mapUsage(response.usage),
    latencyMs: Date.now() - started,
    requestId,
    raw: {
      request,
      response,
      chunkCount: null,
      requestId,
      systemFingerprint: typeof response.system_fingerprint === "string" ? response.system_fingerprint : null,
      headers: idLikeHeaders(http.headers),
      error: null,
    },
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 把 `secrets`（当前 apiKey）在文本里整体替换成 `***`；空串跳过。落盘前的最后兜底。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

/** 从 SDK 错误上捞 request id（`APIError.requestID`），没有就 null。 */
export function requestIdFromError(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  for (const key of ["requestID", "request_id", "requestId"]) {
    const value = error[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  const headers = error.headers;
  if (headers instanceof Headers || isRecord(headers)) {
    return requestIdFromHeaders(headers);
  }
  return null;
}

/**
 * 把错误对象变成可落盘的 JSON：名字、消息、HTTP 状态、错误体、request id、栈。
 * 只挑已知字段，不整个序列化，避免把 SDK 内部对象（含请求头）写进文件。
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: "Unknown", message: String(error) };
  }
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const record: Record<string, unknown> = isRecord(error) ? error : {};
  for (const key of ["status", "code", "type", "param"]) {
    if (record[key] !== undefined && record[key] !== null) {
      out[key] = record[key];
    }
  }
  const requestId = requestIdFromError(error);
  if (requestId !== null) {
    out.requestId = requestId;
  }
  if (record.error !== undefined) {
    out.body = record.error;
  }
  if (error.cause !== undefined) {
    out.cause = formatError(error.cause);
  }
  if (typeof error.stack === "string") {
    out.stack = error.stack;
  }
  return out;
}

export type ProviderModel = {
  id: string;
  ownedBy: string | null;
};

export async function listProviderModels(config: ResolvedConfig): Promise<ProviderModel[]> {
  const url = `${config.baseURL.replace(/\/+$/u, "")}/models`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`列出模型失败：HTTP ${String(response.status)} ${text.slice(0, 200)}`);
  }
  const body: unknown = JSON.parse(text);
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const models: ProviderModel[] = [];
  for (const row of rows) {
    if (typeof row === "string" && row !== "") {
      models.push({ id: row, ownedBy: null });
      continue;
    }
    if (!isRecord(row)) {
      continue;
    }
    const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
    if (id === "") {
      continue;
    }
    const ownedBy =
      typeof row.owned_by === "string"
        ? row.owned_by
        : typeof row.owner === "string"
          ? row.owner
          : null;
    models.push({ id, ownedBy });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}
