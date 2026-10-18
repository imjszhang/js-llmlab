import OpenAI from "openai";
import type {
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { ChatMessage, ConfigSnapshot, RawCapture, ResolvedConfig, TokenUsage } from "../types.ts";
import { validateApiMessages, validateRequestExtras } from "./chat-options.ts";
import { isAnthropicProvider, validateAnthropicChatRequest } from "./anthropic.ts";

export type CompletionResult = {
  text: string;
  reasoning: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
  /** 响应头 `x-request-id`，网关不给就是 null。 */
  requestId: string | null;
  /** 原始请求 / 响应，落 `nodes/<id>.raw.json`；假 completer 可以不给。 */
  raw: RawCapture | null;
  /** 服务端返回的实际模型 / 版本名称，用于识别滚动升级。 */
  responseModel?: string;
  /** 高级请求的完整 assistant 消息，供后续工具调用原样回传。 */
  assistantMessage?: Record<string, unknown>;
};

export type CompletionOptions = {
  /** 整次执行预算到期时取消请求；也供 withRetries 停止后续尝试。 */
  signal?: AbortSignal;
  stream?: boolean;
  onDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  /** 附加请求参数；messages 可为包含图片、工具结果及 reasoning_content 的完整历史。 */
  request?: Record<string, unknown>;
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

export function createClient(config: ResolvedConfig, baseURL = config.baseURL): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL,
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

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("请求已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 给任意 completer 加指数退避重试，次数取 `config.maxRetries`。
 * 流式一旦已经吐出内容就不再重试（否则终端会重复打印），直接把错误抛给调用方。
 */
export function withRetries(complete: Completer, options: RetryOptions = {}): Completer {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  return async (config, messages, completionOptions = {}) => {
    const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, completionOptions.signal));
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
      completionOptions.signal?.throwIfAborted();
      try {
        return await complete(config, messages, guarded);
      } catch (error) {
        if (completionOptions.signal?.aborted === true || streamed || attempt >= config.maxRetries) {
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
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const reasoningRaw = details?.reasoning_tokens ?? usage.reasoning_tokens;
  const hit = usage.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const miss = usage.prompt_cache_miss_tokens ?? (typeof hit === "number" ? promptTokens - hit : undefined);
  // 有些兼容网关会回负数、小数或互相矛盾的缓存统计。仅保留可自洽的整数组合，
  // 否则按未知缓存处理；原值仍完整保留在 raw.response，节点也能再次读回。
  const validCache = typeof hit === "number" && Number.isSafeInteger(hit) && hit >= 0 && hit <= promptTokens &&
    typeof miss === "number" && Number.isSafeInteger(miss) && miss >= 0 && miss <= promptTokens &&
    Number.isSafeInteger(promptTokens) && hit + miss === promptTokens;
  return {
    promptTokens,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
    reasoningTokens: typeof reasoningRaw === "number" ? reasoningRaw : null,
    ...(validCache ? { promptCacheHitTokens: hit, promptCacheMissTokens: miss } : {}),
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
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  validateRequestExtras(extras);
  if (isAnthropicProvider(config) && (config.thinking !== null || config.reasoningEffort !== null)) {
    throw new Error("Anthropic Chat 兼容接口不支持通用 thinking / reasoningEffort 控制；请使用 api messages --provider anthropic --request <原生JSON>。");
  }
  const params: Record<string, unknown> = {
    ...extras,
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    messages: extras.messages === undefined ? messages : validateApiMessages(extras.messages),
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
  validateOfficialToolHistory(config, params);
  validateAnthropicChatRequest(config, params);
  return params;
}

function isOfficialDeepSeek(config: ConfigSnapshot): boolean {
  try {
    return new URL(config.baseURL).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

function validateOfficialToolHistory(config: ConfigSnapshot, request: Record<string, unknown>): void {
  if (!isOfficialDeepSeek(config) || config.thinking === "disabled" || !Array.isArray(request.tools) || request.tools.length === 0) return;
  if (!Array.isArray(request.messages)) return;
  for (const [index, message] of request.messages.entries()) {
    if (!isRecord(message) || message.role !== "assistant" || message.prefix === true) continue;
    if ((typeof message.content === "string" && message.content !== "") || Array.isArray(message.tool_calls)) {
      if (typeof message.reasoning_content !== "string" && message.reasoning_content !== null) {
        throw new Error(`官方思考模式携带 tools 时，messages[${String(index)}] 必须完整回传 reasoning_content；请使用保存的 assistantMessage 或 --messages`);
      }
    }
  }
  if (request.tool_choice === "required" || isRecord(request.tool_choice)) {
    throw new Error("官方思考模式不支持强制 tool_choice；请使用 --thinking disabled");
  }
}

/** 官方前缀续写与 strict 工具调用需要 /beta；第三方网关沿用用户配置地址。 */
export function chatRequestBaseURL(config: ConfigSnapshot, request: Record<string, unknown>): string {
  if (!isOfficialDeepSeek(config)) return config.baseURL;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const last: unknown = messages[messages.length - 1];
  const prefix = isRecord(last) && last.role === "assistant" && last.prefix === true;
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const strict = tools.some((tool: unknown) => isRecord(tool) && isRecord(tool.function) && tool.function.strict === true);
  return prefix || strict ? "https://api.deepseek.com/beta" : config.baseURL;
}

/** 流式工具参数是字符串增量，按 index 合并，不能用最后一个 delta 覆盖前面的 arguments。 */
function appendToolCalls(calls: Map<number, Record<string, unknown>>, delta: unknown): void {
  if (!isRecord(delta) || !Array.isArray(delta.tool_calls)) return;
  for (const call of delta.tool_calls) {
    if (!isRecord(call) || typeof call.index !== "number" || !Number.isInteger(call.index) || call.index < 0) continue;
    const current = calls.get(call.index) ?? {};
    if (typeof call.id === "string") current.id = call.id;
    if (typeof call.type === "string") current.type = call.type;
    if (isRecord(call.function)) {
      const fn = isRecord(current.function) ? current.function : {};
      for (const [key, value] of Object.entries(call.function)) {
        if (typeof value === "string") fn[key] = `${typeof fn[key] === "string" ? fn[key] : ""}${value}`;
        else fn[key] = value;
      }
      current.function = fn;
    }
    calls.set(call.index, current);
  }
}

function assertCompletionFinished(finishReason: string | null, requestId: string | null): void {
  let message: string | null = null;
  if (finishReason === null) message = "模型响应未完成：缺少 finish_reason，可能在生成中途断开";
  if (finishReason === "aborted" || finishReason === "insufficient_system_resource") {
    message = `模型响应被中断：${finishReason}`;
  }
  if (message !== null) {
    throw Object.assign(new Error(message), requestId === null ? {} : { requestID: requestId });
  }
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
  const started = Date.now();
  const stream = options.stream === true;
  const request = buildChatRequest(config, messages, stream, options.request);
  const client = createClient(config, chatRequestBaseURL(config, request));
  const keepMessage = options.request?.messages !== undefined || request.tools !== undefined;

  if (stream) {
    const { data: response, response: http } = await client.chat.completions
      .create(toSdkParams(request, true), options.signal === undefined ? {} : { signal: options.signal })
      .withResponse();
    const requestId = requestIdFromHeaders(http.headers);

    let text = "";
    let reasoning = "";
    let usage: TokenUsage | null = null;
    let rawUsage: unknown = null;
    let chunkCount = 0;
    let first: Record<string, unknown> | null = null;
    let finishReason: string | null = null;
    const toolCalls = new Map<number, Record<string, unknown>>();
    const logprobs: Record<string, unknown[]> = {};
    for await (const chunk of response) {
      chunkCount += 1;
      if (first === null) {
        first = { ...chunk };
      }
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      appendToolCalls(toolCalls, delta);
      if (isRecord(choice?.logprobs)) {
        for (const [key, values] of Object.entries(choice.logprobs)) {
          if (Array.isArray(values)) logprobs[key] = [...(logprobs[key] ?? []), ...values];
        }
      }
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
    assertCompletionFinished(finishReason, requestId);
    // 流式没有「完整响应对象」，按非流式的形状拼一个，方便对照。
    const assistantMessage: Record<string, unknown> = {
      role: "assistant",
      content: text === "" && toolCalls.size > 0 ? null : text,
      reasoning_content: reasoning === "" ? null : reasoning,
      ...(toolCalls.size > 0 ? { tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}),
    };
    const assembled: Record<string, unknown> = {
      id: first?.id ?? null,
      object: "chat.completion",
      created: first?.created ?? null,
      model: first?.model ?? null,
      system_fingerprint: first?.system_fingerprint ?? null,
      choices: [
        {
          index: 0,
          message: assistantMessage,
          finish_reason: finishReason,
          ...(Object.keys(logprobs).length > 0 ? { logprobs } : {}),
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
      ...(typeof first?.model === "string" ? { responseModel: first.model } : {}),
      ...(keepMessage ? { assistantMessage } : {}),
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

  const { data: response, response: http } = await client.chat.completions
    .create(toSdkParams(request, false), options.signal === undefined ? {} : { signal: options.signal })
    .withResponse();
  const requestId = requestIdFromHeaders(http.headers);
  assertCompletionFinished(response.choices[0]?.finish_reason ?? null, requestId);
  const message = response.choices[0]?.message;
  const text = readStringField(message, ["content"]);
  const reasoning = readStringField(message, ["reasoning_content", "reasoning", "thinking"]);
  return {
    text,
    reasoning: reasoning === "" ? null : reasoning,
    usage: mapUsage(response.usage),
    latencyMs: Date.now() - started,
    requestId,
    ...(response.model !== "" ? { responseModel: response.model } : {}),
    ...(keepMessage && message !== undefined ? { assistantMessage: { ...message } } : {}),
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

export { listModels as listProviderModels } from "./provider-models.ts";
export type { ProviderModel } from "./provider-models.ts";
