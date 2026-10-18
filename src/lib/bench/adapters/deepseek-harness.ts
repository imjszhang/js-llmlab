import path from "node:path";
import type { TokenUsage } from "../../../types.ts";
import type { ExecutionEvent, HarnessContext, HarnessPlan, ParsedHarnessResult, ProcessResult, ResolvedHarnessTarget } from "../types.ts";

const KEY_ENV = "JS_LLMLAB_HARNESS_API_KEY";

/** Native DSH Messages transport, using only the two shipped headless bundles. */
export function planDeepSeekHarness(target: ResolvedHarnessTarget, context: HarnessContext, apiKey?: string): HarnessPlan {
  if (target.backend.protocol !== "anthropic-messages") throw new Error("DeepSeek Harness requires an anthropic-messages backend");
  const home = path.resolve(context.home);
  const workspace = path.resolve(context.workspace);
  const dshHome = path.join(home, "dsh");
  const profile = path.join(dshHome, "profiles", "headless");
  const patchPath = path.join(dshHome, "bench.patch.yml");
  // DSH's adapter owns this internal registry name. The lab's provider, endpoint,
  // credential reference and model remain the independently resolved target.
  const patches: Array<Record<string, unknown>> = [
    { id: "llm-deepseek", config: { baseURL: target.backend.baseURL.replace(/\/+$/u, ""), apiKeyEnv: KEY_ENV, models: [{ id: target.backend.model }] } },
    { id: "agent-default-model", config: { provider: "deepseek-official", model: target.backend.model } },
    { id: "sandbox-policy", config: { mode: target.profile.permission, workspaceRoot: workspace } },
    { id: "approval", config: { policy: "never" } },
    { id: "permission", config: { presets: { [target.profile.permission]: { sandbox: target.profile.permission, approval: "never" } }, defaultPreset: target.profile.permission } },
    { id: "session-persistence-jsonl", config: { root: path.join(dshHome, "sessions"), compression: "none" } },
  ];
  // No discovery of personal instructions, credentials, skills, plugins, MCP or
  // auxiliary web/model routes. Parent-only JSON usage excludes delegated agents,
  // so this initial benchmark profile also disables delegation and PTC workflows.
  for (const id of [
    "hmr", "plugin-manager", "tool-plugin-manager", "config-editor", "settings",
    "credentials", "authorization", "deepseek-account", "llm-deepseek-account", "llm-pi-ai",
    "session-title-llm", "otel", "session-telemetry-otel", "agent-instructions", "skill-filesystem", "tool-skill",
    "web", "web-search-deepseek", "web-fetch-http", "tool-web", "mcp-resources",
    "tool-subagent", "tool-subagent-fork", "tool-subagent-control", "tool-subagent-list-agents", "tool-workflow", "workflow-ptc", "ptc-runtime",
  ]) patches.push({ id, disabled: true });
  if (target.profile.permission === "read-only") {
    // Filesystem mutations are independently denied by sandbox-policy. Excluding
    // shells also avoids startup probes and mutable temporary files in read tasks.
    patches.push({ id: "tool-bash", disabled: true }, { id: "tool-pwsh", disabled: true });
  }
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: dshHome,
    AGENTS_HOME: path.join(home, "agents"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    GIT_CEILING_DIRECTORIES: workspace,
    DSH_PERMISSION_MODE: target.profile.permission,
    DSH_TELEMETRY_DISABLED: "1",
    OTEL_SDK_DISABLED: "true",
    NO_COLOR: "1",
  };
  if (apiKey !== undefined) env[KEY_ENV] = apiKey;
  return {
    route: "anthropic-messages",
    files: [
      { path: path.join(profile, "package.json"), content: JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }, null, 2) + "\n" },
      { path: path.join(profile, "cordis.yml"), content: "[]\n" },
      { path: path.join(profile, "cordis.patch.yml"), content: "[]\n" },
      { path: patchPath, content: JSON.stringify(patches, null, 2) + "\n" },
    ],
    // DSH disposes its own managed subprocess ranges on SIGTERM. Its local shell
    // teardown grants three seconds, so allow it to finish before forcing KILL.
    process: { executable: target.profile.executable, args: ["--profile", "headless", "--patch", patchPath, "--json", "-"], cwd: workspace, env, stdin: context.prompt, timeoutMs: context.timeoutMs, terminationGraceMs: 4000 },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function count(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }

function stepUsage(value: unknown): TokenUsage | null {
  const data = record(value);
  if (data === null) return null;
  const input = count(data.inputTokens);
  const output = count(data.outputTokens);
  if (input === null || output === null) return null;
  const hit = count(data.cacheReadTokens);
  const created = count(data.cacheWriteTokens);
  // The native Messages adapter's inputTokens excludes cache-read and cache-write
  // buckets, just like Anthropic input_tokens. They still count as prompt tokens.
  const prompt = input + (hit ?? 0) + (created ?? 0);
  return {
    promptTokens: prompt,
    completionTokens: output,
    totalTokens: count(data.totalTokens) ?? prompt + output,
    reasoningTokens: count(data.reasoningTokens),
    ...(hit === null ? {} : { promptCacheHitTokens: hit, promptCacheMissTokens: input + (created ?? 0) }),
  };
}

function aggregateUsage(steps: Array<TokenUsage | null>): TokenUsage | null {
  if (steps.length === 0 || steps.some((step) => step === null)) return null;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let reasoning: number | null = 0;
  let hit: number | null = 0;
  let miss: number | null = 0;
  for (const step of steps) {
    if (step === null) return null;
    prompt += step.promptTokens;
    completion += step.completionTokens;
    total += step.totalTokens;
    reasoning = reasoning === null || step.reasoningTokens === null ? null : reasoning + step.reasoningTokens;
    hit = hit === null || step.promptCacheHitTokens === undefined ? null : hit + step.promptCacheHitTokens;
    miss = miss === null || step.promptCacheMissTokens === undefined ? null : miss + step.promptCacheMissTokens;
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total, reasoningTokens: reasoning, ...(hit === null ? {} : { promptCacheHitTokens: hit }), ...(miss === null ? {} : { promptCacheMissTokens: miss }) };
}

/** Parse the released headless JSON projection; exit 0 alone is never success. */
export function parseDeepSeekHarnessOutput(result: ProcessResult): ParsedHarnessResult {
  const events: ExecutionEvent[] = [];
  const steps: Array<TokenUsage | null> = [];
  const stepKeys = new Set<string>();
  const turnKeys = new Set<string>();
  let text = "";
  let reasoning: string | null = null;
  let sessionId: string | null = null;
  let final = false;
  let turnEnd = false;
  let completed = false;
  let malformed = false;
  let error: string | null = result.error;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      malformed = true;
      events.push({ type: "raw", data: line });
      continue;
    }
    const event = record(parsed);
    events.push({ type: "raw", data: parsed });
    if (event === null || typeof event.type !== "string") { malformed = true; continue; }
    // `final` closes the documented stream. Keep trailing evidence without letting
    // it replace the terminal answer or transform a failed lifecycle into success.
    if (final) { malformed = true; continue; }
    if (event.type === "session") {
      const id = string(event.sessionId);
      if (id === null || id === "" || sessionId !== null || final) malformed = true;
      else sessionId = id;
      events.push({ type: "session", data: parsed });
    } else if (event.type === "text") {
      text = string(event.text) ?? text;
      events.push({ type: "message", data: parsed });
    } else if (event.type === "thinking") {
      if (typeof event.text === "string") reasoning = (reasoning ?? "") + event.text;
    } else if (event.type === "tool_call" || event.type === "tool_result") {
      events.push({ type: "tool", data: parsed });
    } else if (event.type === "status" && event.phase === "step_end") {
      // A step's projection already includes usage from its retried attempts.
      // Never sum message deltas as well, or accept duplicate terminal samples.
      const key = JSON.stringify([event.turn, event.step]);
      if (stepKeys.has(key) || final) malformed = true;
      stepKeys.add(key);
      steps.push(stepUsage(event.usage));
      if (event.usage !== undefined) events.push({ type: "usage", data: event.usage });
    } else if (event.type === "status" && event.phase === "turn_end") {
      const key = JSON.stringify(event.turn) ?? "missing-turn";
      if (turnKeys.has(key)) malformed = true;
      turnKeys.add(key);
      turnEnd = true;
      const reason = record(event.reason);
      completed = reason?.kind === "completed";
      if (!completed) {
        const detail = record(reason?.error);
        error ??= string(detail?.message) ?? `DeepSeek Harness turn ended: ${String(reason?.kind ?? "unknown")}`;
        events.push({ type: "error", data: parsed });
      }
    } else if (event.type === "final") {
      if (final || typeof event.text !== "string" || !turnEnd) malformed = true;
      final = true;
      text = string(event.text) ?? text;
      events.push({ type: "message", data: parsed });
    } else if (event.type === "error") {
      error ??= string(event.message) ?? "DeepSeek Harness reported an error";
      events.push({ type: "error", data: parsed });
    }
  }
  if (result.timedOut) error ??= "DeepSeek Harness process timed out";
  else if (result.exitCode !== 0) error ??= `DeepSeek Harness process exited with ${result.signal ?? String(result.exitCode)}`;
  else if (malformed) error ??= "DeepSeek Harness emitted malformed JSON events";
  else if (sessionId === null || !final || !turnEnd || !completed) error ??= "DeepSeek Harness ended without a terminal completion event";
  return {
    status: result.timedOut ? "timeout" : error !== null ? "failed" : "completed",
    text, reasoning,
    // Incomplete attempts and missing step samples make the total unknown.
    usage: final && completed && !malformed ? aggregateUsage(steps) : null,
    cost: null,
    sessionId,
    // The headless projection does not publish the responding model identity.
    responseModel: null,
    events,
    error,
  };
}
