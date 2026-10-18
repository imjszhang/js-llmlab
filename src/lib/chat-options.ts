import { readFile } from "node:fs/promises";
import type { ChatMessage } from "../types.ts";

/** run / compare 的高级 Chat Completions 输入；文件路径按当前工作目录解析。 */
export type ChatInputOptions = {
  image?: string[];
  fileId?: string[];
  jsonOutput?: boolean;
  tools?: string;
  messages?: string;
  prefix?: string;
  request?: string;
};

const CONFIG_FIELDS = new Set([
  "model", "temperature", "max_tokens", "thinking", "reasoning_effort", "stream", "stream_options",
]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`${label} 无法读取文件 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error(`${label} 文件不是有效 JSON：${file}`);
  }
}

/** 保持 API 原始消息字段（含 reasoning_content / tool_calls），不缩成纯文本。 */
export function validateApiMessages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("messages 必须是非空 JSON 数组");
  }
  const out: Record<string, unknown>[] = [];
  for (const [index, message] of value.entries()) {
    if (!isRecord(message) || !["system", "user", "assistant", "tool"].includes(String(message.role))) {
      throw new Error(`messages[${String(index)}] 必须包含有效 role（system / user / assistant / tool）`);
    }
    const content = message.content;
    const toolCalls = message.tool_calls;
    const validContent = typeof content === "string" || Array.isArray(content) ||
      (message.role === "assistant" && content === null);
    if (!validContent) {
      throw new Error(`messages[${String(index)}].content 必须是字符串或内容块数组（assistant 可为 null）`);
    }
    if (message.role === "system" && typeof content !== "string") {
      throw new Error(`messages[${String(index)}] 的 system content 必须是字符串`);
    }
    if (message.role === "assistant" && content === null && !Array.isArray(toolCalls)) {
      throw new Error(`messages[${String(index)}] 的空 assistant 必须携带 tool_calls`);
    }
    if (message.role === "tool" && (typeof message.tool_call_id !== "string" || message.tool_call_id === "")) {
      throw new Error(`messages[${String(index)}] 的 tool 消息必须包含 tool_call_id`);
    }
    out.push(structuredClone(message));
  }
  return out;
}

/** 附加参数不能覆盖参与配置快照的字段，也不能改变 CLI 选择的流模式。 */
export function validateRequestExtras(value: Record<string, unknown>, allowMessages = true): void {
  for (const key of Object.keys(value)) {
    if (CONFIG_FIELDS.has(key) || (!allowMessages && key === "messages")) {
      throw new Error(`--request 不允许覆盖 ${key}；请使用对应的 CLI 选项${key === "messages" ? " --messages" : ""}`);
    }
  }
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function imageUrl(input: string): Promise<string> {
  if (/^https?:\/\//iu.test(input)) {
    if (input.length > 8192) throw new Error("图片 URL 最长为 8192 字符；请改用本地图片或 --file-id");
    const url = new URL(input);
    if (url.hostname === "") throw new Error(`无效图片 URL：${input}`);
    return input;
  }
  if (input.startsWith("data:")) {
    const match = /^data:image\/(?:jpeg|png|gif|webp);base64,([a-z\d+/]+={0,2})$/iu.exec(input);
    if (match?.[1] === undefined) throw new Error("图片 data URL 必须是 JPEG / PNG / GIF / WebP 的 base64 数据");
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("内联图片最大为 32 MiB；请上传后使用 --file-id");
    if (imageMime(bytes) === null) throw new Error("图片内容不是 JPEG / PNG / GIF / WebP");
    return input;
  }
  const bytes = await readFile(input);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("本地图片最大为 32 MiB；请上传后使用 --file-id");
  const mime = imageMime(bytes);
  if (mime === null) throw new Error(`不支持的图片内容：${input}（支持 JPEG / PNG / GIF / WebP）`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * 将文件、图片与高级消息合成可复用的附加请求体。纯文本旧路径返回空对象。
 * apiMessages 是会话树恢复的完整 API 历史，--messages 可显式替换它；输入一律不原地修改。
 */
export async function prepareChatRequest(
  messages: ChatMessage[],
  options: ChatInputOptions,
  apiMessages?: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const extras: Record<string, unknown> = {};
  if (options.request !== undefined) {
    const value = await readJson(options.request, "--request");
    if (!isRecord(value)) throw new Error("--request 文件必须是 JSON 对象");
    validateRequestExtras(value, false);
    Object.assign(extras, value);
  }
  if (options.tools !== undefined) {
    const tools = await readJson(options.tools, "--tools");
    if (!Array.isArray(tools) || tools.some((tool) => !isRecord(tool))) {
      throw new Error("--tools 文件必须是工具定义的 JSON 数组");
    }
    extras.tools = tools;
  }
  const advanced = apiMessages !== undefined || options.messages !== undefined || options.prefix !== undefined ||
    options.jsonOutput === true || (options.image?.length ?? 0) > 0 || (options.fileId?.length ?? 0) > 0 ||
    Object.keys(extras).length > 0;
  if (!advanced) return extras;
  const api = options.messages !== undefined
    ? validateApiMessages(await readJson(options.messages, "--messages"))
    : validateApiMessages(apiMessages ?? messages);

  const parts: Record<string, unknown>[] = [];
  for (const image of options.image ?? []) parts.push({ type: "image_url", image_url: { url: await imageUrl(image) } });
  for (const fileId of options.fileId ?? []) {
    if (fileId.trim() === "") throw new Error("--file-id 不能为空");
    parts.push({ type: "file", file_id: fileId });
  }
  if (parts.length > 0) {
    const user = [...api].reverse().find((message) => message.role === "user");
    if (user === undefined) throw new Error("添加图片或文件需要至少一条 user 消息");
    const content = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content;
    if (!Array.isArray(content)) throw new Error("图片只能添加到字符串或内容块数组形式的 user 消息");
    user.content = [...content, ...parts];
  }
  if (options.jsonOutput === true) {
    extras.response_format = { type: "json_object" };
    const instruction = "请仅输出有效的 JSON 对象。";
    const system = api.find((message) => message.role === "system");
    if (system !== undefined && typeof system.content === "string") system.content += `\n\n${instruction}`;
    else api.unshift({ role: "system", content: instruction });
  }
  if (options.prefix !== undefined) api.push({ role: "assistant", content: options.prefix, prefix: true });
  let images = 0;
  for (const message of api) {
    if (Array.isArray(message.content)) {
      images += message.content.filter((part: unknown) => isRecord(part) && ["image_url", "file"].includes(String(part.type))).length;
    }
  }
  if (images > 600) throw new Error("每个请求最多包含 600 张图片");
  extras.messages = api;
  return extras;
}
