import path from "node:path";
import type { TokenUsage } from "../../../types.ts";
import type { ExecutionEvent, HarnessContext, HarnessPlan, ParsedHarnessResult, ProcessRequest, ProcessResult, ResolvedHarnessTarget } from "../types.ts";

const KEY_ENV = "JS_LLMLAB_HARNESS_API_KEY";

/** OpenCode V2 Promise plugin: no imports or dependencies, and no secret on disk. */
const SHELL_ENV_PLUGIN = `export default {
  id: "js-llmlab.shell-environment",
  setup: async (ctx) => {
    await ctx.shell.hook("create.before", (invocation) => {
      for (const name of Object.keys(invocation.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD|OPENCODE_CONFIG_CONTENT/i.test(name)) invocation.env[name] = undefined;
      }
    });
  },
};
`;

/** The supported wire format is @opencode/cli V2 (verified against 2.0.32). */
export function planOpenCode(target: ResolvedHarnessTarget, context: HarnessContext, apiKey?: string): HarnessPlan {
  if (target.backend.protocol !== "chat-completions") throw new Error("OpenCode requires a chat-completions backend");
  const home = path.resolve(context.home);
  const workspace = path.resolve(context.workspace);
  const configDir = path.join(home, "opencode", "config");
  const pluginDir = path.join(home, "opencode", "shell-environment");
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", ...(target.profile.permission === "workspace-write" ? ["edit", "shell"] : [])]
      .map((action) => ({ action, resource: "*", effect: "allow" })),
    { action: "external_directory", resource: "*", effect: "deny" },
  ];
  const config = {
    model: `js_llmlab/${target.backend.model}`,
    default_agent: "build",
    update: "disable",
    share: "disabled",
    snapshots: false,
    formatter: false,
    lsp: false,
    warming: false,
    mcp: { servers: {} },
    instructions: [],
    skills: [],
    permissions,
    // Auxiliary title/summary jobs are outside the task's visible tool loop.
    agents: { build: { permissions }, title: { disabled: true }, summary: { disabled: true } },
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "js_llmlab", effect: "allow" },
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
      { action: "integration.use", resource: "skill:*", effect: "deny" },
      { action: "integration.use", resource: "plugin:*", effect: "deny" },
      { action: "integration.use", resource: `plugin:${pluginDir}`, effect: "allow" },
    ],
    plugins: ["-opencode.config.instruction", "-opencode.config.skill", "-opencode.config.compatibility", "-opencode.skill", pluginDir],
    providers: {
      js_llmlab: {
        name: "js-llmlab isolated backend",
        env: [KEY_ENV],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: target.backend.baseURL.replace(/\/+$/u, ""), timeout: context.timeoutMs },
        models: { [target.backend.model]: { name: target.backend.model, capabilities: { tools: true } } },
      },
    },
  };
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    GIT_CEILING_DIRECTORIES: workspace,
    PWD: workspace,
    NO_COLOR: "1",
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_DISABLE_FFF: "1",
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
  };
  if (apiKey !== undefined) env[KEY_ENV] = apiKey;
  return {
    route: "chat-completions",
    files: [
      { path: path.join(configDir, "opencode.json"), content: JSON.stringify(config, null, 2) + "\n" },
      { path: path.join(pluginDir, "package.json"), content: JSON.stringify({ name: "js-llmlab-shell-environment", private: true, type: "module", exports: "./index.mjs" }, null, 2) + "\n" },
      { path: path.join(pluginDir, "index.mjs"), content: SHELL_ENV_PLUGIN },
    ],
    process: {
      executable: target.profile.executable,
      args: ["run", "--standalone", "--format", "json", "--thinking", "--model", `js_llmlab/${target.backend.model}`, "--agent", "build"],
      cwd: workspace,
      env,
      stdin: context.prompt,
      timeoutMs: context.timeoutMs,
      // V2's private server allows managed shell jobs three seconds to shut down.
      terminationGraceMs: 4000,
    },
  };
}

/** A local read of the completed native session; no provider credential is needed. */
export function planOpenCodeInspection(target: ResolvedHarnessTarget, context: HarnessContext, sessionId: string): ProcessRequest {
  if (!/^ses_[A-Za-z0-9]+$/u.test(sessionId)) throw new Error("Invalid OpenCode session ID for inspection");
  return { ...planOpenCode(target, context).process, args: ["session", "export", "--standalone", sessionId], stdin: "" };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function count(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }

type MessageContent = { ordinals: Map<string, number>; blocks: Map<number, string>; projected: Map<string, string> };

/** V2 reconciliation emits only the missing suffix, under a projected block ID. */
function appendContent(messages: Map<string, MessageContent>, message: string, id: string, value: string, kind: "text" | "reasoning"): boolean {
  let content = messages.get(message);
  if (content === undefined) {
    content = { ordinals: new Map(), blocks: new Map(), projected: new Map() };
    messages.set(message, content);
  }
  const prefix = `prt_${message.replace(/^msg_/u, "")}_${kind}-`;
  const suffix = id.startsWith(prefix) ? id.slice(prefix.length) : "";
  if (/^\d+$/u.test(suffix)) {
    const ordinal = Number(suffix);
    if (!Number.isSafeInteger(ordinal)) return false;
    const previous = content.projected.get(id);
    if (previous !== undefined) return previous === value;
    content.projected.set(id, value);
    content.blocks.set(ordinal, (content.blocks.get(ordinal) ?? "") + value);
    return true;
  }
  let ordinal = content.ordinals.get(id);
  if (ordinal === undefined) {
    ordinal = content.ordinals.size;
    content.ordinals.set(id, ordinal);
  }
  content.blocks.set(ordinal, value);
  return true;
}

function contentText(content: MessageContent | undefined): string {
  return content === undefined ? "" : [...content.blocks].sort(([left], [right]) => left - right).map(([, value]) => value).join("");
}

function readUsage(value: unknown): TokenUsage | null {
  const tokens = record(value);
  if (tokens === null) return null;
  const input = count(tokens.input);
  const output = count(tokens.output);
  const reasoning = count(tokens.reasoning);
  const cache = record(tokens.cache);
  const hit = count(cache?.read);
  const write = count(cache?.write);
  if (input === null || output === null || reasoning === null || hit === null || write === null) return null;
  // V2 output excludes reasoning, and input excludes cache read/write (TokenUsage.total).
  const promptTokens = input + hit + write;
  const completionTokens = output + reasoning;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: reasoning, promptCacheHitTokens: hit, promptCacheMissTokens: input + write };
}

/** A clean exit must follow a final stop step; EOF, a tool step or truncated JSON is not success. */
export function parseOpenCodeOutput(result: ProcessResult): ParsedHarnessResult {
  return parseOpenCodeStream(result).result;
}

type ParsedStream = { result: ParsedHarnessResult; recoverableMissingTerminal: boolean };

function parseOpenCodeStream(result: ProcessResult): ParsedStream {
  const events: ExecutionEvent[] = [];
  const textParts = new Map<string, MessageContent>();
  const reasoningParts = new Map<string, MessageContent>();
  const steps = new Map<string, TokenUsage | null>();
  const completedMessages = new Set<string>();
  let sessionId: string | null = null;
  let error = result.error;
  let malformed = false;
  let latestTextMessage: string | null = null;
  let finalStepMessage: string | null = null;
  let lastStepReason: string | null = null;
  let delegated = false;
  let nativeError = false;
  let mismatchedSessions = false;
  let unexpectedMessage = false;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { malformed = true; events.push({ type: "raw", data: line }); continue; }
    events.push({ type: "raw", data: parsed });
    const event = record(parsed);
    if (event === null || typeof event.type !== "string") { malformed = true; continue; }
    const currentSession = string(event.sessionID);
    if (["step_start", "step_finish", "text", "reasoning", "tool_use"].includes(event.type) && (currentSession === null || currentSession === "")) malformed = true;
    if (currentSession !== null && currentSession !== "") {
      if (sessionId !== null && sessionId !== currentSession) {
        mismatchedSessions = true;
        error ??= "OpenCode emitted events from multiple sessions";
      }
      if (sessionId === null) events.push({ type: "session", data: { sessionID: currentSession } });
      sessionId = currentSession;
    }
    const part = record(event.part);
    const id = string(part?.id);
    const message = string(part?.messageID);
    if (["step_start", "step_finish", "text", "reasoning", "tool_use"].includes(event.type) && (message === null || message === "")) malformed = true;
    if (["text", "reasoning", "tool_use"].includes(event.type) && lastStepReason === "stop" && (message === null || !completedMessages.has(message))) {
      unexpectedMessage = true;
      error ??= "OpenCode emitted a new message after the final stop step without starting a new step";
    }
    if (event.type === "step_start") lastStepReason = null;
    else if (event.type === "text" || event.type === "reasoning") {
      const value = string(part?.text);
      if (id === null || message === null || value === null) { malformed = true; continue; }
      const parts = event.type === "text" ? textParts : reasoningParts;
      if (!appendContent(parts, message, id, value, event.type)) malformed = true;
      if (event.type === "text") { latestTextMessage = message; events.push({ type: "message", data: parsed }); }
    } else if (event.type === "tool_use") {
      if (part?.tool === "subagent" || part?.tool === "task") delegated = true;
      events.push({ type: "tool", data: parsed });
    } else if (event.type === "step_finish") {
      if (id === null || message === null || typeof part?.reason !== "string") { malformed = true; continue; }
      lastStepReason = part.reason;
      finalStepMessage = message;
      completedMessages.add(message);
      steps.set(`${message}\u0000${id}`, readUsage(part.tokens));
      events.push({ type: "usage", data: parsed });
    } else if (event.type === "error") {
      nativeError = true;
      const failure = record(event.error);
      error ??= string(failure?.message) ?? string(record(failure?.data)?.message) ?? string(event.error) ?? "OpenCode reported an error";
      events.push({ type: "error", data: parsed });
    }
  }
  let usage: TokenUsage | null = null;
  if (steps.size > 0 && !delegated && [...steps.values()].every((step) => step !== null)) {
    usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0 };
    for (const step of steps.values()) {
      if (step === null) continue;
      usage.promptTokens += step.promptTokens;
      usage.completionTokens += step.completionTokens;
      usage.totalTokens += step.totalTokens;
      usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (step.reasoningTokens ?? 0);
      usage.promptCacheHitTokens = (usage.promptCacheHitTokens ?? 0) + (step.promptCacheHitTokens ?? 0);
      usage.promptCacheMissTokens = (usage.promptCacheMissTokens ?? 0) + (step.promptCacheMissTokens ?? 0);
    }
  }
  if (result.timedOut) error ??= "OpenCode process timed out";
  else if (result.exitCode !== 0) error ??= `OpenCode process exited with ${result.signal ?? String(result.exitCode)}`;
  else if (malformed) error ??= "OpenCode emitted malformed JSON events";
  else if (lastStepReason !== "stop") error ??= `OpenCode ended without a terminal stop step${lastStepReason === null ? "" : ` (${lastStepReason})`}`;
  // A final step may contain no text. Never promote an earlier tool step's
  // commentary into its final answer. Keep partial output only without a stop.
  const outputMessage = lastStepReason === "stop" ? finalStepMessage : latestTextMessage;
  const text = outputMessage === null ? "" : contentText(textParts.get(outputMessage));
  const reasoning = [...reasoningParts.values()].map(contentText).join("\n") || null;
  // Custom models have no pricing metadata. OpenCode otherwise synthesizes cost=0,
  // which is not evidence of a free request; keep the reported step values in raw events.
  return {
    result: { status: result.timedOut ? "timeout" : error === null ? "completed" : "failed", text, reasoning, usage, cost: null, sessionId, responseModel: null, events, error },
    recoverableMissingTerminal: result.error === null && result.exitCode === 0 && !result.timedOut && !malformed && !nativeError && !mismatchedSessions && !unexpectedMessage && (lastStepReason === null || lastStepReason === "tool-calls"),
  };
}

/**
 * V2 2.0.32 can finish session.wait before consuming its final step event.
 * Its official export supplies the durable outcome and complete messages.
 * Only this missing-terminal race may be recovered; stream errors stay errors.
 */
export function parseOpenCodeInspection(target: ResolvedHarnessTarget, context: HarnessContext, run: ProcessResult, inspection: ProcessResult): ParsedHarnessResult {
  const stream = parseOpenCodeStream(run);
  const streamed = stream.result;
  const events = [...streamed.events];
  const failed = (message: string, timeout = false): ParsedHarnessResult => ({ ...streamed, status: timeout ? "timeout" : "failed", usage: null, cost: null, events, error: message });
  let exported: unknown;
  try { exported = JSON.parse(inspection.stdout); }
  catch { events.push({ type: "raw", data: { source: "opencode-session-export", stdout: inspection.stdout } }); }
  if (exported !== undefined) events.push({ type: "raw", data: { source: "opencode-session-export", export: exported } });
  if (inspection.timedOut) return failed("OpenCode session inspection timed out", true);
  if (inspection.error !== null) return failed(`OpenCode session inspection failed: ${inspection.error}`);
  if (inspection.exitCode !== 0) return failed(`OpenCode session inspection exited with ${inspection.signal ?? String(inspection.exitCode)}`);
  if (run.timedOut) return failed(streamed.error ?? "OpenCode process timed out", true);
  if (run.error !== null || run.exitCode !== 0) return failed(streamed.error ?? "OpenCode process failed");
  if (streamed.status !== "completed" && !stream.recoverableMissingTerminal) return failed(streamed.error ?? "OpenCode emitted an invalid event stream");
  if (streamed.sessionId === null) return failed("OpenCode session inspection cannot verify a missing session ID");
  const data = record(exported);
  const info = record(data?.info);
  const location = record(info?.location);
  const model = record(info?.model);
  if (info?.id !== streamed.sessionId) return failed("OpenCode session export does not match the executed session");
  if (model?.providerID !== "js_llmlab" || model.id !== target.backend.model) return failed("OpenCode session export backend does not match the target");
  if (typeof location?.directory !== "string" || path.resolve(location.directory) !== path.resolve(context.workspace)) return failed("OpenCode session export workspace does not match the task");
  if (!Array.isArray(data?.messages)) return failed("OpenCode session export has no message history");
  const messages = data.messages.map(record);
  if (messages.some((message) => message === null)) return failed("OpenCode session export has malformed messages");
  const users = messages.filter((message) => message?.type === "user");
  if (users.length !== 1 || users[0]?.text !== context.prompt) return failed("OpenCode session export input does not match the task");
  const assistants = messages.filter((message): message is Record<string, unknown> => message?.type === "assistant");
  const final = assistants.at(-1);
  const finalTime = record(final?.time);
  const idle = messages.at(-1);
  const idleTime = record(info.time);
  if (info.outcome !== "succeeded" || idle?.type !== "idle" || idle.outcome !== "succeeded" || count(idleTime?.idle) === null) return failed("OpenCode session export has no successful native terminal outcome");
  if (final === undefined || final.finish !== "stop" || count(finalTime?.completed) === null || final.error !== undefined) return failed("OpenCode session export has no completed final stop message");
  const assistantIds = new Set(assistants.map((message) => string(message.id)));
  const streamedText = new Map<string, MessageContent>();
  let delegated = false;
  for (const event of events) {
    if (event.type !== "raw") continue;
    const raw = record(event.data);
    const part = record(raw?.part);
    const messageID = string(part?.messageID);
    if (["step_start", "step_finish", "text", "reasoning", "tool_use"].includes(string(raw?.type) ?? "") && (messageID === null || !assistantIds.has(messageID))) return failed("OpenCode session export does not contain an emitted assistant message");
    if (raw?.type === "text" && messageID !== null && typeof part?.id === "string" && typeof part.text === "string") appendContent(streamedText, messageID, part.id, part.text, "text");
    if (raw?.type === "tool_use" && (part?.tool === "subagent" || part?.tool === "task")) delegated = true;
  }
  const textBlocks = (message: Record<string, unknown>, kind: "text" | "reasoning"): string[] => Array.isArray(message.content) ? message.content.flatMap((item: unknown) => {
    const block = record(item);
    return block?.type === kind && typeof block.text === "string" ? [block.text] : [];
  }) : [];
  for (const message of assistants) {
    const ownModel = record(message.model);
    if (ownModel?.providerID !== "js_llmlab" || ownModel.id !== target.backend.model) return failed("OpenCode session export contains an unexpected assistant backend");
    if (message.error !== undefined || count(record(message.time)?.completed) === null) return failed("OpenCode session export contains an unfinished or failed assistant message");
    const content = streamedText.get(string(message.id) ?? "");
    const full = textBlocks(message, "text");
    if (content !== undefined && [...content.blocks].some(([ordinal, value]) => !(full[ordinal]?.startsWith(value) ?? false))) return failed("OpenCode session export text does not match the emitted output");
    if (Array.isArray(message.content) && message.content.some((item: unknown) => { const tool = record(item); return tool?.type === "tool" && (tool.name === "subagent" || tool.name === "task"); })) delegated = true;
  }
  const usage = delegated ? null : readUsage(info.tokens);
  if (usage !== null) events.push({ type: "usage", data: { source: "opencode-session-export", tokens: info.tokens } });
  events.push({ type: "message", data: { source: "opencode-session-export", message: final } });
  const reasoning = assistants.flatMap((message) => textBlocks(message, "reasoning")).join("") || streamed.reasoning;
  return { ...streamed, status: "completed", text: textBlocks(final, "text").join(""), reasoning, usage, cost: null, error: null, events };
}
