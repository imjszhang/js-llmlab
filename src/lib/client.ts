import OpenAI from "openai";
import type { ChatMessage, ResolvedConfig, TokenUsage } from "../types.ts";

export type CompletionResult = {
  text: string;
  usage: TokenUsage | null;
  latencyMs: number;
};

export type CompletionOptions = {
  stream?: boolean;
  onDelta?: (chunk: string) => void;
};

export function createClient(config: ResolvedConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

function mapUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): TokenUsage | null {
  if (usage === undefined) {
    return null;
  }
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
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
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let text = "";
    let usage: TokenUsage | null = null;
    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta !== undefined && delta !== null && delta !== "") {
        text += delta;
        options.onDelta?.(delta);
      }
      const mapped = mapUsage(chunk.usage ?? undefined);
      if (mapped !== null) {
        usage = mapped;
      }
    }
    return { text, usage, latencyMs: Date.now() - started };
  }

  const response = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    messages,
  });
  const text = response.choices[0]?.message.content ?? "";
  return {
    text,
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
