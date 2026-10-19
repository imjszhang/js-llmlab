import path from "node:path";
import { applyExecutionPolicy } from "./execution-policy.ts";
import type { TokenUsage } from "../../types.ts";
import type { ExecutionEvent, HarnessAdapter, HarnessContext, HarnessPlan, ParsedHarnessResult, ProcessResult, ResolvedHarnessTarget } from "./types.ts";
import { planDeepSeekHarness, parseDeepSeekHarnessOutput } from "./adapters/deepseek-harness.ts";
import { planOpenCode, parseOpenCodeOutput } from "./adapters/opencode.ts";
import { planClaudeSubscription } from "./adapters/claude-subscription.ts";
import { planCursorAgent } from "./adapters/cursor-agent.ts";
import { parseCursorOutput } from "./adapters/cursor-output.ts";

/** Build a reproducible invocation without reading auth, changing the parent environment, or writing files. */
export function planHarness(target: ResolvedHarnessTarget, context: HarnessContext, apiKey?: string): HarnessPlan {
  return applyExecutionPolicy(target, context, basePlanHarness(target, context, apiKey));
}

function basePlanHarness(target: ResolvedHarnessTarget, context: HarnessContext, apiKey?: string): HarnessPlan {
  if (target.backend.auth === "cursor-login" || target.backend.auth === "cursor-api-key") {
    if (target.profile.adapter !== "cursor-agent") throw new Error("Cursor native backend requires Cursor Agent");
    return planCursorAgent({ ...target, backend: target.backend }, context, apiKey);
  }
  if (target.profile.adapter === "cursor-agent") throw new Error("Cursor Agent requires a native Cursor backend");
  if (target.backend.auth === "claude-subscription") {
    if (target.profile.adapter !== "claude-code") throw new Error("Claude subscription requires Claude Code");
    return planClaudeSubscription({ ...target, backend: target.backend }, context);
  }
  if (target.backend.auth === "chatgpt" && target.profile.adapter !== "codex") throw new Error("ChatGPT subscription requires Codex");
  if (target.profile.adapter === "deepseek-harness") return planDeepSeekHarness(target, context, apiKey);
  if (target.profile.adapter === "opencode") return planOpenCode(target, context, apiKey);
  const home = path.resolve(context.home);
  const workspace = path.resolve(context.workspace);
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    NO_COLOR: "1",
  };
  if (target.profile.adapter === "claude-code") {
    if (target.backend.protocol !== "anthropic-messages") throw new Error("Claude Code requires an anthropic-messages backend");
    const tools = target.profile.permission === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash";
    const settings = path.join(home, "claude", "settings.json");
    env.CLAUDE_CONFIG_DIR = path.join(home, "claude");
    // Claude's SDK adds /v1/messages itself; providers store the versioned API prefix.
    env.ANTHROPIC_BASE_URL = target.backend.baseURL.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    env.DISABLE_AUTOUPDATER = "1";
    env.DISABLE_TELEMETRY = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (apiKey !== undefined) env.ANTHROPIC_API_KEY = apiKey;
    return {
      route: "anthropic-messages",
      files: [{ path: settings, content: JSON.stringify({
        disableAllHooks: true,
        permissions: { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true },
        ...(target.profile.permission === "workspace-write" ? { sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
          credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }] },
        } } : {}),
      }, null, 2) + "\n" }],
      process: {
        executable: target.profile.executable,
        args: ["-p", "--output-format", "stream-json", "--verbose", "--bare", "--safe-mode", "--restricted", "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", tools, "--allowedTools", tools, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", settings, "--setting-sources", "", "--model", target.backend.model],
        cwd: workspace,
        env,
        stdin: context.prompt,
        timeoutMs: context.timeoutMs,
      },
    };
  }
  if (target.backend.auth !== "chatgpt" && target.backend.protocol !== "responses") throw new Error("Codex requires a responses backend");
  const subscription = target.backend.auth === "chatgpt";
  env.CODEX_HOME = target.backend.auth === "chatgpt" ? target.backend.codexHome : path.join(home, "codex");
  if (!subscription && apiKey !== undefined) env.JS_LLMLAB_HARNESS_API_KEY = apiKey;
  const config: Record<string, string | boolean | number> = {
    ...(target.backend.auth === "chatgpt" ? {
      model_provider: "openai",
      openai_base_url: "https://api.openai.com/v1",
      chatgpt_base_url: "https://chatgpt.com/backend-api",
      sqlite_home: path.join(home, "codex-state"),
      log_dir: path.join(home, "codex-logs"),
      "history.persistence": "none",
      "features.hooks": false,
      "features.apps": false,
      "features.memories": false,
      "features.skip_host_skill_discovery": true,
      "features.skill_search": false,
      "features.skill_mcp_dependency_install": false,
      "agents.enabled": false,
      "analytics.enabled": false,
      "feedback.enabled": false,
      web_search: "disabled",
      default_permissions: "js_llmlab_subscription",
      "permissions.js_llmlab_subscription.extends": target.profile.permission === "workspace-write" ? ":workspace" : ":read-only",
    } : {
      model_provider: "js_llmlab",
      "model_providers.js_llmlab.name": "js-llmlab isolated backend",
      "model_providers.js_llmlab.base_url": target.backend.baseURL.replace(/\/+$/u, ""),
      "model_providers.js_llmlab.env_key": "JS_LLMLAB_HARNESS_API_KEY",
      "model_providers.js_llmlab.wire_api": "responses",
      "model_providers.js_llmlab.requires_openai_auth": false,
    }),
    approval_policy: "never",
    cli_auth_credentials_store: target.backend.auth === "chatgpt" ? target.backend.credentialsStore : "file",
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.ignore_default_excludes": false,
    project_doc_max_bytes: 0,
    "features.plugins": false,
    [`projects.${JSON.stringify(workspace)}.trust_level`]: "untrusted",
  };
  if (target.backend.reasoningEffort !== undefined) config.model_reasoning_effort = target.backend.reasoningEffort;
  // --sandbox would override the named profile and remove its auth-directory denial.
  const args = ["--no-daemon", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    ...(subscription ? [] : ["--sandbox", target.profile.permission]), "--model", target.backend.model];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  if (target.backend.auth === "chatgpt") {
    // An inline table is required: quoted path segments in dotted CLI keys are treated literally.
    args.push("-c", `permissions.js_llmlab_subscription.filesystem={ ${JSON.stringify(target.backend.codexHome)} = "deny" }`);
  }
  args.push("-c", "mcp_servers={}", "-c", subscription
    ? 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*","*PASSWORD*","*PROXY*","*proxy*","CODEX_HOME"]'
    : 'shell_environment_policy.exclude=["*KEY*","*TOKEN*","*SECRET*"]', "-");
  return { route: "responses", files: [], process: { executable: target.profile.executable, args, cwd: workspace, env, stdin: context.prompt, timeoutMs: context.timeoutMs } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function count(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function usage(value: unknown, adapter: HarnessAdapter): TokenUsage | null {
  const data = record(value);
  if (data === null) return null;
  const input = count(data.input_tokens);
  const output = count(data.output_tokens);
  if (input === null || output === null) return null;
  const hit = count(adapter === "claude-code" ? data.cache_read_input_tokens : data.cached_input_tokens);
  const created = adapter === "claude-code" ? count(data.cache_creation_input_tokens) : null;
  // Anthropic's input_tokens excludes both cache read and cache creation tokens.
  const prompt = input + (adapter === "claude-code" ? (hit ?? 0) + (created ?? 0) : 0);
  const reasoning = count(data.reasoning_output_tokens);
  return {
    promptTokens: prompt,
    completionTokens: output,
    totalTokens: prompt + output,
    reasoningTokens: reasoning,
    ...(hit !== null ? { promptCacheHitTokens: hit } : {}),
    ...(adapter === "claude-code" && hit !== null ? { promptCacheMissTokens: input + (created ?? 0) } : {}),
  };
}

function messageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((block: unknown) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

/** Unknown events are preserved. Only a valid terminal event can turn an execution into a success. */
export function parseHarnessOutput(adapter: HarnessAdapter, result: ProcessResult): ParsedHarnessResult {
  if (adapter === "cursor-agent") return parseCursorOutput(result);
  if (adapter === "deepseek-harness") return parseDeepSeekHarnessOutput(result);
  if (adapter === "opencode") return parseOpenCodeOutput(result);
  const events: ExecutionEvent[] = [];
  let text = "";
  let reasoning: string | null = null;
  let tokens: TokenUsage | null = null;
  let cost: ParsedHarnessResult["cost"] = null;
  let sessionId: string | null = null;
  let responseModel: string | null = null;
  let completed = false;
  let error: string | null = result.error;
  let malformed = false;
  let terminalFailure = false;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      malformed = true;
      events.push({ type: "raw", data: line });
      continue;
    }
    const event = record(parsed);
    if (event === null || typeof event.type !== "string") {
      malformed = true;
      events.push({ type: "raw", data: parsed });
      continue;
    }
    events.push({ type: "raw", data: parsed });
    if (adapter === "claude-code") {
      sessionId = string(event.session_id) ?? sessionId;
      if (event.type === "system" && event.subtype === "init") {
        responseModel = string(event.model) ?? responseModel;
        events.push({ type: "session", data: parsed });
      } else if (event.type === "assistant") {
        const message = record(event.message);
        responseModel = string(message?.model) ?? responseModel;
        const content = message?.content;
        const output = messageText(content);
        if (output !== "") text = output;
        if (Array.isArray(content)) {
          for (const block of content) {
            const item = record(block);
            if (item?.type === "tool_use") events.push({ type: "tool", data: item });
            if (item?.type === "thinking" && typeof item.thinking === "string") reasoning = (reasoning ?? "") + item.thinking;
          }
        }
        events.push({ type: "message", data: parsed });
      } else if (event.type === "result") {
        const successful = event.subtype === "success" && event.is_error !== true;
        if (successful) completed = true;
        else {
          terminalFailure = true;
          const errors = Array.isArray(event.errors) ? event.errors.filter((value): value is string => typeof value === "string").join("; ") : "";
          error ??= string(event.result) ?? (errors || `Claude Code result: ${String(event.subtype)}`);
          events.push({ type: "error", data: parsed });
        }
        text = string(event.result) ?? text;
        tokens = usage(event.usage, adapter);
        const models = record(event.modelUsage);
        if (models !== null) {
          const names = Object.keys(models);
          if (names.length > 0) responseModel = names.length === 1 ? names[0] ?? null : null;
        }
        const total = count(event.total_cost_usd);
        if (total !== null) cost = { input: null, output: null, total, currency: "USD" };
        if (tokens !== null) events.push({ type: "usage", data: event.usage });
      } else if (event.type === "error") {
        terminalFailure = true;
        error ??= string(event.message) ?? JSON.stringify(event.error ?? event);
        events.push({ type: "error", data: parsed });
      }
    } else {
      if (event.type === "thread.started") {
        sessionId = string(event.thread_id) ?? sessionId;
        events.push({ type: "session", data: parsed });
      } else if (event.type === "item.completed") {
        const item = record(event.item);
        if (item?.type === "agent_message") {
          text = string(item.text) ?? text;
          events.push({ type: "message", data: parsed });
        } else if (item?.type === "reasoning") {
          reasoning = string(item.text) ?? reasoning;
        } else events.push({ type: "tool", data: parsed });
      } else if (event.type === "turn.completed") {
        completed = true;
        tokens = usage(event.usage, adapter);
        if (tokens !== null) events.push({ type: "usage", data: event.usage });
      } else if (event.type === "turn.failed") {
        terminalFailure = true;
        const failure = record(event.error);
        error ??= string(failure?.message) ?? string(event.error) ?? "Codex turn failed";
        events.push({ type: "error", data: parsed });
      } else if (event.type === "error") {
        terminalFailure = true;
        error ??= string(event.message) ?? "Codex reported an error";
        events.push({ type: "error", data: parsed });
      }
      responseModel = string(event.model) ?? responseModel;
    }
  }
  if (result.timedOut) error ??= "Harness process timed out";
  else if (result.exitCode !== 0) error ??= `Harness process exited with ${result.signal ?? String(result.exitCode)}`;
  else if (malformed) error ??= "Harness emitted malformed JSON events";
  else if (!completed) error ??= "Harness ended without a terminal completion event";
  const status = result.timedOut ? "timeout" : error !== null || terminalFailure ? "failed" : "completed";
  return { status, text, reasoning, usage: tokens, cost, sessionId, responseModel, events, error };
}
