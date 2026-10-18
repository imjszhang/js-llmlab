import type { ConfigSnapshot } from "../types.ts";

/** Anthropic 命名 provider 可使用自定义兼容网关，官方域名也自动识别。 */
export function isAnthropicProvider(config: Pick<ConfigSnapshot, "provider" | "baseURL">): boolean {
  if (config.provider === "anthropic") return true;
  try { return new URL(config.baseURL).hostname === "api.anthropic.com"; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 原生 Messages 可完整使用 Claude 参数；Chat 兼容层不应把被忽略的功能记成生效。 */
export function validateAnthropicChatRequest(config: ConfigSnapshot, request: Record<string, unknown>): void {
  if (!isAnthropicProvider(config)) return;
  const unsupported = ["reasoning_effort", "response_format", "logprobs", "top_logprobs", "presence_penalty", "frequency_penalty", "seed", "prediction", "audio", "modalities", "service_tier", "store", "user", "metadata", "output_config", "cache_control"];
  for (const field of unsupported) {
    if (request[field] !== undefined && request[field] !== null) {
      throw new Error(`Anthropic 的 Chat 兼容接口不支持 ${field}；请使用 api messages --provider anthropic --request <原生JSON>。`);
    }
  }
  const model = typeof request.model === "string" ? request.model : config.model;
  const generation = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/u.exec(model);
  const major = Number(generation?.[1] ?? 0);
  const minor = Number(generation?.[2] ?? 0);
  if (typeof request.temperature === "number") {
    if (request.temperature < 0 || request.temperature > 1) throw new Error("Anthropic temperature 必须在 0 至 1 之间");
    if ((major >= 5 || major === 4 && minor >= 7) && request.temperature !== 1) {
      throw new Error(`模型 ${model} 只接受 temperature=1，请使用 --temperature 1。`);
    }
  }
  if (request.temperature !== undefined && request.top_p !== undefined) {
    throw new Error("Anthropic 不能同时设置 temperature 与 top_p；原生参数请使用 api messages。");
  }
  if ((major >= 5 || major === 4 && minor >= 7) && request.top_p !== undefined && request.top_p !== 0.99) {
    throw new Error(`模型 ${model} 只接受默认 top_p=0.99，请省略该参数。`);
  }
  if (request.n !== undefined && request.n !== 1) throw new Error("Anthropic Chat 兼容接口的 n 必须为 1");
  const stops = typeof request.stop === "string" ? [request.stop] : Array.isArray(request.stop) ? request.stop : [];
  if (stops.some((stop) => typeof stop === "string" && stop.trim() === "")) {
    throw new Error("Anthropic Chat 兼容接口会忽略纯空白 stop，请使用有效停止词。");
  }
  const tools = Array.isArray(request.tools) ? request.tools : [];
  for (const tool of tools) {
    if (isRecord(tool) && isRecord(tool.function) && tool.function.strict === true) {
      throw new Error("Anthropic Chat 兼容接口会忽略工具 strict；严格 schema 请使用 api messages 原生接口。");
    }
  }
  const functions = Array.isArray(request.functions) ? request.functions : [];
  if (functions.some((fn) => isRecord(fn) && fn.strict === true)) {
    throw new Error("Anthropic Chat 兼容接口会忽略 functions.strict；严格 schema 请使用 api messages 原生接口。");
  }
  const forced = request.tool_choice === "required" || isRecord(request.tool_choice);
  if (forced && /^claude-(?:(?:opus|sonnet)-5-5|(?:fable|mythos)-5-1)(?:-|$)/u.test(model)) {
    throw new Error(`模型 ${model} 不支持强制工具调用，请将 tool_choice 设为 auto。`);
  }
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) scan(item); return; }
    if (!isRecord(value)) return;
    if (value.cache_control !== undefined) throw new Error("Anthropic Chat 兼容接口不支持缓存控制；请使用 api messages 原生接口。");
    if (value.type === "file" || value.type === "input_audio") throw new Error(`Anthropic Chat 兼容接口不支持 ${String(value.type)} 内容块；请使用 api messages 原生接口。`);
    if (value.prefix === true) throw new Error("Anthropic Chat 兼容接口不支持此 prefix 续写选项；请按 Claude 模型限制使用原生 Messages。");
    for (const child of Object.values(value)) scan(child);
  };
  scan(request.messages);
}
