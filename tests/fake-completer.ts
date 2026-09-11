import type { Completer, CompletionOptions, CompletionResult } from "../src/lib/client.ts";
import type { ChatMessage, ResolvedConfig, TokenUsage } from "../src/types.ts";

/**
 * 一条假回复的规则。按 `config.name`（命名配置）或 `config.model` 匹配。
 */
export type FakeReply = {
  /** 成稿。缺省回显最后一条 user 消息；传函数可按收到的 messages 定制。 */
  text?: string | ((messages: ChatMessage[]) => string);
  reasoning?: string | null;
  usage?: TokenUsage | null;
  /** 模拟网关延迟。 */
  delayMs?: number;
  /** 前 N 次调用抛错，之后成功。 */
  failTimes?: number;
  /** 抛错时的消息。 */
  error?: string;
};

export type FakeCall = {
  config: ResolvedConfig;
  messages: ChatMessage[];
  options: CompletionOptions;
  startedAt: number;
};

export type FakeCompleter = {
  complete: Completer;
  calls: FakeCall[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      return message.content;
    }
  }
  return "";
}

function defaultUsage(messages: ChatMessage[], text: string, reasoning: string | null): TokenUsage {
  const promptTokens = messages.reduce((sum, m) => sum + m.content.length, 0);
  const reasoningTokens = reasoning === null ? 0 : reasoning.length;
  const completionTokens = text.length + reasoningTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    reasoningTokens: reasoning === null ? null : reasoningTokens,
  };
}

/**
 * 创建假 completer。`rules` 的 key 是配置名或模型 id；没命中时用 `fallback`。
 * 开了 `options.stream` 时把成稿切成三段依次调 `onDelta`，方便测流式路径。
 */
export function createFakeCompleter(
  rules: Record<string, FakeReply> = {},
  fallback: FakeReply = {},
): FakeCompleter {
  const calls: FakeCall[] = [];
  const failures = new Map<string, number>();

  const complete: Completer = async (config, messages, options = {}) => {
    const key = rules[config.name] !== undefined ? config.name : config.model;
    const rule = rules[key] ?? fallback;
    calls.push({ config, messages, options, startedAt: Date.now() });

    if (rule.delayMs !== undefined && rule.delayMs > 0) {
      await sleep(rule.delayMs);
    }

    const failTimes = rule.failTimes ?? 0;
    const failed = failures.get(key) ?? 0;
    if (failed < failTimes) {
      failures.set(key, failed + 1);
      throw new Error(rule.error ?? `fake failure for ${key}`);
    }

    const text =
      typeof rule.text === "function"
        ? rule.text(messages)
        : (rule.text ?? `echo: ${lastUser(messages)}`);
    const reasoning = rule.reasoning === undefined ? null : rule.reasoning;

    if (options.stream === true) {
      if (reasoning !== null && options.onReasoningDelta !== undefined) {
        options.onReasoningDelta(reasoning);
      }
      if (options.onDelta !== undefined) {
        const third = Math.ceil(text.length / 3) || 1;
        for (let i = 0; i < text.length; i += third) {
          options.onDelta(text.slice(i, i + third));
        }
      }
    }

    const result: CompletionResult = {
      text,
      reasoning,
      usage: rule.usage === undefined ? defaultUsage(messages, text, reasoning) : rule.usage,
      latencyMs: rule.delayMs ?? 1,
    };
    return result;
  };

  return { complete, calls };
}

/** 一被调用就抛错，用来证明某条路径确实没有发请求。 */
export function throwingCompleter(message = "不应发起请求"): Completer {
  return () => Promise.reject(new Error(message));
}
