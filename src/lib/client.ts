import OpenAI from "openai";
import type {
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { ChatMessage, ConfigSnapshot, ResolvedConfig, TokenUsage } from "../types.ts";

export type CompletionResult = {
  text: string;
  reasoning: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
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
    const response = await client.chat.completions.create(
      toSdkParams(buildChatRequest(config, messages, true), true),
    );

    let text = "";
    let reasoning = "";
    let usage: TokenUsage | null = null;
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
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
      const mapped = mapUsage(chunk.usage);
      if (mapped !== null) {
        usage = mapped;
      }
    }
    return {
      text,
      reasoning: reasoning === "" ? null : reasoning,
      usage,
      latencyMs: Date.now() - started,
    };
  }

  const response = await client.chat.completions.create(
    toSdkParams(buildChatRequest(config, messages, false), false),
  );
  const message = response.choices[0]?.message;
  const text = readStringField(message, ["content"]);
  const reasoning = readStringField(message, ["reasoning_content", "reasoning", "thinking"]);
  return {
    text,
    reasoning: reasoning === "" ? null : reasoning,
    usage: mapUsage(response.usage),
    latencyMs: Date.now() - started,
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
