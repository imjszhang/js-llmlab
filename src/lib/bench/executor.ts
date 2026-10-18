import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildChatRequest,
  formatError,
  redactSecrets,
  runCompletion,
  serializeError,
  withRetries,
} from "../client.ts";
import { computeCost } from "../cost.ts";
import type { ChatMessage, ResolvedConfig } from "../../types.ts";
import { parseHarnessOutput, planHarness } from "./harness.ts";
import { parseOpenCodeInspection, planOpenCodeInspection } from "./adapters/opencode.ts";
import { parseCursorOutput } from "./adapters/cursor-output.ts";
import { runProcess } from "./process.ts";
import { proxyEnvironment, proxySecrets } from "./network-environment.ts";
import { isCursorBackend, isSubscriptionBackend, targetApiKeyEnv } from "./backend.ts";
import { codexNetworkEnvironment, CodexMetadataTimeoutError, readCodexAccount } from "./codex-account.ts";
import { claudeNetworkEnvironment, ClaudeMetadataTimeoutError, readClaudeAccount } from "./claude-account.ts";
import { assertCursorAgentVersion, cursorCommonArgs, CursorMetadataTimeoutError, readCursorAccount } from "./cursor-account.ts";
import type { ExecutionInput, ExecutionResult, ExecutorDeps, HarnessPlan, ProcessResult } from "./types.ts";

/** Scrub available model and proxy credentials, including unrelated backends. */
export function executionSecrets(apiKeyEnv: string | undefined): string[] {
  const names = Object.keys(process.env).filter((name) =>
    /api_?key|(?:^|_)(?:token|secret|password|credential)(?:_|$)/iu.test(name),
  );
  const credentials = [...names, ...(apiKeyEnv === undefined ? [] : [apiKeyEnv])].flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value === "" ? [] : [value];
  });
  return [...new Set([...credentials, ...proxySecrets()])].sort((left, right) => right.length - left.length);
}

export function redactExecutionValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactExecutionValue(entry, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, secrets), redactExecutionValue(entry, secrets),
    ]));
  }
  return value;
}

function redactResult(result: ExecutionResult, secrets: readonly string[]): ExecutionResult {
  const clean = (value: string | null) => value === null ? null : redactSecrets(value, secrets);
  return {
    ...result,
    text: redactSecrets(result.text, secrets),
    reasoning: clean(result.reasoning),
    cost: result.cost === null ? null : { ...result.cost, currency: redactSecrets(result.cost.currency, secrets) },
    sessionId: clean(result.sessionId),
    responseModel: clean(result.responseModel),
    error: clean(result.error),
    stdout: redactSecrets(result.stdout, secrets),
    stderr: redactSecrets(result.stderr, secrets),
    harnessVersion: clean(result.harnessVersion),
    raw: redactExecutionValue(result.raw, secrets),
    events: result.events.map((event) => ({ ...event, data: redactExecutionValue(event.data, secrets) })),
  };
}

/** Native subscription credentials never enter our env; scrub recognizable auth diagnostics without reading their store. */
function redactSubscriptionResult(result: ExecutionResult): ExecutionResult {
  const clean = (value: string): string => value
    .replace(/\bsk-ant-[a-zA-Z0-9_-]+/gu, "***")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/giu, "Bearer ***")
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/gu, "***")
    .replace(/("(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken|authorization)"\s*:\s*")[^"\r\n]*(")/giu, "$1***$2");
  const nested = (value: unknown): unknown => {
    if (typeof value === "string") return clean(value);
    if (Array.isArray(value)) return value.map(nested);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken|authorization)$/iu.test(key) ? "***" : nested(item),
    ]));
    return value;
  };
  return { ...result, text: clean(result.text), reasoning: result.reasoning === null ? null : clean(result.reasoning),
    sessionId: result.sessionId === null ? null : clean(result.sessionId),
    responseModel: result.responseModel === null ? null : clean(result.responseModel),
    harnessVersion: result.harnessVersion === null ? null : clean(result.harnessVersion),
    error: result.error === null ? null : clean(result.error), stdout: clean(result.stdout), stderr: clean(result.stderr),
    raw: nested(result.raw), events: result.events.map((event) => ({ ...event, data: nested(event.data) })) };
}

function failed(
  error: string,
  started: number,
  kind: "llm" | "harness",
  extras: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    status: "failed", text: "", reasoning: null, usage: null, cost: null,
    sessionId: null, responseModel: null, events: [], error,
    latencyMs: Date.now() - started, exitCode: null, stdout: "", stderr: "",
    raw: null, harnessVersion: null,
    usageSource: kind === "llm" ? "request" : "run-total", costSource: null,
    ...extras,
  };
}

/** Return on budget expiry even if an injected completer does not observe cancellation. */
async function withinBudget<T>(
  budgetMs: number,
  controller: AbortController,
  action: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("任务执行超时");
      controller.abort(error);
      reject(error);
    }, budgetMs);
  });
  try {
    return await Promise.race([action(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function writePlanFiles(plan: HarnessPlan, home: string, sharedAuth?: "chatgpt" | "claude-subscription"): Promise<void> {
  const resolvedHome = path.resolve(home);
  await mkdir(resolvedHome, { recursive: true });
  const actualHome = await realpath(resolvedHome);
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"]) {
    // Native subscription auth owns its existing directory; never create or write it here.
    if ((name === "CODEX_HOME" && sharedAuth === "chatgpt") || (name === "CLAUDE_CONFIG_DIR" && sharedAuth === "claude-subscription")) continue;
    const directory = plan.process.env?.[name];
    if (directory === undefined) continue;
    const resolved = path.resolve(directory);
    if (!contained(resolvedHome, resolved)) throw new Error("Harness 配置目录必须位于本次配置目录内");
    await mkdir(resolved, { recursive: true });
    if (!contained(actualHome, await realpath(resolved))) throw new Error("Harness 配置目录的符号链接越界");
  }
  for (const file of plan.files) {
    const filePath = path.resolve(file.path);
    if (!contained(resolvedHome, filePath)) throw new Error("Harness 配置文件必须位于本次配置目录内");
    await mkdir(path.dirname(filePath), { recursive: true });
    if (!contained(actualHome, await realpath(path.dirname(filePath)))) {
      throw new Error("Harness 配置目录的符号链接越界");
    }
    try {
      if ((await lstat(filePath)).isSymbolicLink()) throw new Error("Harness 配置文件不能是符号链接");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await writeFile(filePath, file.content, { encoding: "utf8", mode: file.mode ?? 0o600 });
    if (file.mode !== undefined) await chmod(filePath, file.mode);
  }
}

export async function executeTarget(input: ExecutionInput, deps: ExecutorDeps = {}): Promise<ExecutionResult> {
  const started = Date.now();
  const { target, task } = input;
  const apiKeyEnv = targetApiKeyEnv(target);
  const subscriptionNetworkEnv = target.kind !== "harness" ? {} : target.backend.auth === "chatgpt"
    ? codexNetworkEnvironment() : target.backend.auth === "claude-subscription" ? claudeNetworkEnvironment() : {};
  const networkEnv = { ...proxyEnvironment(), ...subscriptionNetworkEnv };
  const secrets = [...executionSecrets(apiKeyEnv), ...Object.values(subscriptionNetworkEnv)];
  const redact = (result: ExecutionResult): ExecutionResult => {
    const cursor = target.kind === "harness" && isCursorBackend(target.backend);
    const normalized = cursor ? { ...result, usage: null, usageSource: null, cost: null, costSource: null, responseModel: null } : result;
    return redactResult(target.kind === "harness" && (isSubscriptionBackend(target.backend) || cursor)
      ? redactSubscriptionResult(normalized) : normalized, secrets);
  };
  const apiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv];
  if (apiKeyEnv !== undefined && (apiKey === undefined || apiKey.trim() === "")) {
    return redact(failed(`缺少环境变量 ${apiKeyEnv}，无法执行 ${target.name}`, started, target.kind));
  }
  const controller = new AbortController();
  let raw: unknown = null;
  let harnessVersion: string | null = null;
  const capture: { lastProcess: ProcessResult | null } = { lastProcess: null };
  try {
    const action = async (): Promise<ExecutionResult> => {
      if (target.kind === "llm") {
        if (apiKey === undefined) throw new Error(`缺少环境变量 ${target.apiKeyEnv}`);
        const config: ResolvedConfig = {
          ...target.config,
          timeoutMs: Math.min(target.config.timeoutMs, task.timeoutMs),
          apiKeyEnv: target.apiKeyEnv,
          apiKey,
        };
        const messages: ChatMessage[] = [];
        if (target.systemText.trim() !== "") messages.push({ role: "system", content: target.systemText });
        messages.push({ role: "user", content: task.prompt });
        raw = { request: buildChatRequest(config, messages, false), response: null };
        const complete = withRetries(deps.complete ?? runCompletion);
        const completion = await complete(config, messages, { signal: controller.signal });
        controller.signal.throwIfAborted();
        const cost = computeCost(completion.usage, config.pricing);
        return {
          status: "completed", text: completion.text, reasoning: completion.reasoning,
          usage: completion.usage, cost, sessionId: null, responseModel: completion.responseModel ?? null,
          events: [], error: null, latencyMs: Date.now() - started,
          exitCode: null, stdout: completion.text, stderr: "", raw: completion.raw ?? raw,
          harnessVersion: null, usageSource: "request", costSource: cost === null ? null : "configured-pricing",
        };
      }

      const runner = deps.runProcess ?? runProcess;
      const context = {
        workspace: input.workspace, home: input.home, prompt: task.prompt, timeoutMs: task.timeoutMs,
      };
      if (isCursorBackend(target.backend)) {
        // Project hooks are discovered separately from native CLI permissions.
        // Never delete candidate input to make it pass the isolation check.
        try {
          await lstat(path.join(input.workspace, ".cursor"));
          throw new Error("Cursor Agent fixture 不能包含 .cursor 目录或文件，以免加载项目 hooks/config");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      }
      const probePlan = planHarness(target, context);
      const plan = planHarness(target, context, apiKey);
      // Capture the same transport environment that the real child receives.
      // Explicit per-plan values take precedence over inherited proxy defaults.
      plan.process.env = { ...networkEnv, ...plan.process.env };
      raw = { plan };
      const probe = await runner({
        executable: isCursorBackend(target.backend) ? target.profile.executable : plan.process.executable,
        args: [...(isCursorBackend(target.backend) ? cursorCommonArgs() : []), "--version"], cwd: input.workspace,
        ...(probePlan.process.env === undefined ? {} : { env: {
          ...networkEnv,
          ...probePlan.process.env,
          ...(target.backend.auth === "chatgpt" ? { CODEX_HOME: path.join(input.home, "codex-probe") } : {}),
          ...(target.backend.auth === "claude-subscription" ? {
            HOME: input.home, USERPROFILE: input.home, CLAUDE_CONFIG_DIR: path.join(input.home, "claude-probe"),
          } : {}),
          ...(isCursorBackend(target.backend) ? { AGENT_CLI_CREDENTIAL_STORE: "memory", NODE_OPTIONS: "", HOME: input.home, USERPROFILE: input.home } : {}),
        } }),
        timeoutMs: Math.max(1, Math.min(5000, task.timeoutMs - (Date.now() - started))),
      });
      raw = { plan, probe };
      capture.lastProcess = probe;
      controller.signal.throwIfAborted();
      if (probe.error !== null || probe.timedOut || probe.exitCode !== 0) {
        return failed(probe.error ?? (probe.timedOut ? "Harness 版本检查超时" : "Harness 版本检查失败"), started, target.kind, {
          ...(probe.timedOut ? { status: "timeout" } : {}),
          raw, stdout: probe.stdout, stderr: probe.stderr, exitCode: probe.exitCode,
        });
      }
      harnessVersion = (probe.stdout.trim() || probe.stderr.trim()) || null;
      if (isCursorBackend(target.backend)) assertCursorAgentVersion(harnessVersion ?? "");
      if (target.backend.auth === "claude-subscription") {
        const version = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(harnessVersion ?? "");
        const major = Number(version?.[1]);
        const minor = Number(version?.[2]);
        const patch = Number(version?.[3]);
        if (version === null || !(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 296))))) {
          return failed("Claude 订阅 adapter 需要 Claude Code 2.1.296 或更新版本，以支持认证元数据与当前隔离参数", started, target.kind,
            { raw, harnessVersion, exitCode: probe.exitCode });
        }
        if (target.backend.claudeConfigDirMode === "default") {
          // Fail before native shell selection can fall back from an unusable wrapper.
          try {
            await access("/usr/bin/sandbox-exec", constants.X_OK);
            await access("/bin/bash", constants.X_OK);
          } catch {
            return failed("Claude 默认订阅模式需要可执行的 macOS sandbox-exec 与 /bin/bash；请修复环境或改用显式账户目录", started, target.kind,
              { raw, harnessVersion });
          }
        }
      }
      if (target.profile.adapter === "opencode" && !/(?:^|\s)v?2\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s|$)/u.test(harnessVersion ?? "")) {
        return failed("OpenCode adapter requires @opencode/cli V2 (verified with 2.0.32); install V2 and ensure opencode resolves to that executable", started, target.kind, {
          raw, stdout: probe.stdout, stderr: probe.stderr, exitCode: probe.exitCode, harnessVersion,
        });
      }
      if (target.backend.auth === "chatgpt") {
        const authBudget = task.timeoutMs - (Date.now() - started);
        if (authBudget <= 0) {
          controller.abort(new Error("任务执行超时"));
          throw controller.signal.reason;
        }
        const account = await readCodexAccount({
          executable: target.profile.executable, codexHome: target.backend.codexHome,
          credentialsStore: target.backend.credentialsStore, timeoutMs: authBudget,
        }, { runProcess: runner });
        raw = { plan, probe, account };
        if (account.auth !== "chatgpt") {
          return failed("Codex 订阅 target 需要当前 ChatGPT 登录；请先在相同 CODEX_HOME 下运行 codex login，再用 harness codex status 确认。不会自动改为 API key 或更改登录。", started, target.kind, { raw, harnessVersion });
        }
      }
      if (target.backend.auth === "claude-subscription") {
        const authBudget = task.timeoutMs - (Date.now() - started);
        if (authBudget <= 0) {
          controller.abort(new Error("任务执行超时"));
          throw controller.signal.reason;
        }
        const account = await readClaudeAccount({
          executable: target.profile.executable, claudeConfigDir: target.backend.claudeConfigDir,
          claudeConfigDirMode: target.backend.claudeConfigDirMode, timeoutMs: authBudget,
        }, { runProcess: runner });
        raw = { plan, probe, account };
        if (account.auth !== "claude-subscription") {
          return failed("Claude 订阅 target 需要当前 claude.ai 登录；请先用原生 claude auth login 登录对应配置目录，再用 harness claude-code status 确认。不会改用 API key 或更改登录。", started, target.kind, { raw, harnessVersion });
        }
      }
      if (target.backend.auth === "cursor-login") {
        const authBudget = task.timeoutMs - (Date.now() - started);
        if (authBudget <= 0) throw new CursorMetadataTimeoutError();
        const account = await readCursorAccount({ executable: target.profile.executable,
          auth: target.backend.auth, timeoutMs: authBudget,
          ...(target.profile.useCurrentUserHomeForLogin === undefined ? {} : { useCurrentUserHomeForLogin: target.profile.useCurrentUserHomeForLogin }),
        }, { runProcess: runner });
        raw = { plan, probe, account };
        if (!account.credentialPresent) {
          return failed("Cursor Agent 未找到完整原生登录凭据；请先运行 cursor-agent login，再用 harness cursor-agent status 确认。", started, target.kind, { raw, harnessVersion });
        }
      }
      await writePlanFiles(plan, input.home, target.backend.auth === "chatgpt" || target.backend.auth === "claude-subscription"
        ? target.backend.auth : undefined);
      controller.signal.throwIfAborted();
      const remaining = task.timeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        controller.abort(new Error("任务执行超时"));
        throw controller.signal.reason;
      }
      const processResult = await runner({ ...plan.process, timeoutMs: remaining });
      capture.lastProcess = processResult;
      controller.signal.throwIfAborted();
      raw = { plan, probe, process: processResult };
      let parsed = isCursorBackend(target.backend)
        ? parseCursorOutput(processResult, { workspace: input.workspace, auth: target.backend.auth })
        : parseHarnessOutput(target.profile.adapter, processResult);
      // Claude's total_cost_usd is a token-price estimate, not a subscription bill.
      if (isSubscriptionBackend(target.backend) || isCursorBackend(target.backend)) parsed = { ...parsed, cost: null };
      // V2's JSON event consumer can end before the final step event is flushed.
      // Confirm the native persisted terminal state through its public export CLI.
      if (target.profile.adapter === "opencode" && processResult.exitCode === 0
        && !processResult.timedOut && processResult.error === null && parsed.sessionId !== null) {
        const inspectionBudget = task.timeoutMs - (Date.now() - started);
        if (inspectionBudget <= 0) {
          return failed("任务执行超时，无法核验 OpenCode 会话终态", started, target.kind, {
            ...parsed, status: "timeout", raw, stdout: processResult.stdout, stderr: processResult.stderr,
            harnessVersion, exitCode: processResult.exitCode,
            error: "任务执行超时，无法核验 OpenCode 会话终态",
          });
        }
        const inspectionContext = { ...context, timeoutMs: inspectionBudget };
        const inspectionPlan = planOpenCodeInspection(target, inspectionContext, parsed.sessionId);
        inspectionPlan.env = { ...networkEnv, ...inspectionPlan.env };
        const inspection = await runner(inspectionPlan);
        raw = { plan, probe, process: processResult, inspectionPlan, inspection };
        parsed = parseOpenCodeInspection(target, context, processResult, inspection);
      }
      return {
        ...parsed, latencyMs: Date.now() - started, exitCode: processResult.exitCode,
        stdout: processResult.stdout, stderr: processResult.stderr, raw, harnessVersion,
        usageSource: isCursorBackend(target.backend) ? null : "run-total", costSource: parsed.cost === null ? null : "harness-reported",
      };
    };
    // Harness runners own process-group cancellation. Wait for their cleanup before
    // grading or snapshotting files; returning a raced timeout leaves writers alive.
    const result = target.kind === "llm"
      ? await withinBudget(task.timeoutMs, controller, action)
      : await action();
    return redact(result);
  } catch (error) {
    const timeout = controller.signal.aborted || error instanceof CodexMetadataTimeoutError || error instanceof ClaudeMetadataTimeoutError || error instanceof CursorMetadataTimeoutError || Date.now() - started >= task.timeoutMs;
    return redact(failed(formatError(error), started, target.kind, {
      ...(timeout ? { status: "timeout" } : {}),
      raw: { capture: raw, error: serializeError(error) }, harnessVersion,
      ...(capture.lastProcess === null ? {} : {
        stdout: capture.lastProcess.stdout, stderr: capture.lastProcess.stderr, exitCode: capture.lastProcess.exitCode,
      }),
    }));
  }
}
