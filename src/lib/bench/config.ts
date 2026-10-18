import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { loadProvider, peekConfigRef } from "../config.ts";
import { resolveSystemText } from "../presets.ts";
import { isClaudeSubscriptionBackend, isCodexSubscriptionBackend, isCursorBackend } from "./backend.ts";
import { freezeManifestCheck } from "./task-constraints.ts";
import type { ApiKeyHarnessBackend, BenchTask, ClaudeSubscriptionBackend, CodexReasoningEffort, CodexSubscriptionBackend, CursorApiKeyBackend, HarnessAdapter, HarnessBackend, HarnessProfile, HarnessProtocol, ResolvedTarget, Target, TaskCheck, TaskManifest, TaskSelfTest, TaskSelfTestCase } from "./types.ts";

const HARNESS_ADAPTERS = ["claude-code", "codex", "deepseek-harness", "opencode", "cursor-agent"] as const;
const HARNESS_PROTOCOLS: Partial<Record<HarnessAdapter, HarnessProtocol>> = {
  "claude-code": "anthropic-messages",
  codex: "responses",
  "deepseek-harness": "anthropic-messages",
  opencode: "chat-completions",
};

function harnessAdapter(value: unknown): value is HarnessAdapter {
  return HARNESS_ADAPTERS.some((adapter) => adapter === value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBenchName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value) || value.includes("..")) {
    throw new Error(`名称必须是安全的字母、数字、下划线或连字符：${value}`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label} 必须是非空单行字符串`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是 > 0 的整数`);
  }
  return value;
}

/** 路径只在任务根/工作区内解释，不接受绝对路径或父目录跳转。 */
export function validateRelativePath(value: string): string {
  if (value === "" || path.isAbsolute(value) || value.includes("\\") || /[\u0000-\u001f]/u.test(value)
      || value.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`路径必须是目录内的相对路径：${value}`);
  }
  if (value.split("/").every((part) => part === ".")) {
    throw new Error(`路径不能指向根目录：${value}`);
  }
  return value;
}

/** 校验已存在路径的每一段，避免符号链接把读取导出项目。 */
export function resolveProjectPath(root: string, value: string): string {
  validateRelativePath(value);
  if (value.split("/").some((part) => part === ".git" || part === "node_modules" || part === "archives"
      || part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))) {
    throw new Error(`路径不能读取私密或忽略目录：${value}`);
  }
  const absoluteRoot = realpathSync(root);
  const resolved = path.resolve(absoluteRoot, value);
  if (!resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`路径不能离开项目根目录：${value}`);
  }
  let cursor = absoluteRoot;
  for (const part of path.relative(absoluteRoot, resolved).split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`不允许符号链接：${value}`);
  }
  return resolved;
}

function json(root: string, dir: string, name: string): Record<string, unknown> {
  validateBenchName(name);
  const file = resolveProjectPath(root, `${dir}/${name}.json`);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!record(value)) throw new Error(`${dir}/${name}.json 必须是 JSON 对象`);
  if (value.name !== name) throw new Error(`${dir}/${name}.json 的 name 必须与文件名一致`);
  return value;
}

function names(root: string, dir: string): string[] {
  const directory = path.join(root, dir);
  if (!existsSync(directory)) return [];
  const safeDirectory = resolveProjectPath(root, dir);
  return readdirSync(safeDirectory).filter((file) => file.endsWith(".json"))
    .map((file) => validateBenchName(file.slice(0, -5))).sort();
}

export function listTargets(root: string): string[] { return names(root, "targets"); }
export function listTasks(root: string): string[] { return names(root, "tasks"); }
export function listHarnesses(root: string): string[] { return names(root, "harnesses"); }

export function loadHarness(root: string, name: string): HarnessProfile {
  const raw = json(root, "harnesses", name);
  if (!harnessAdapter(raw.adapter)) {
    throw new Error(`harness ${name} adapter 只能是 ${HARNESS_ADAPTERS.join("、")}`);
  }
  if (raw.permission !== "read-only" && raw.permission !== "workspace-write") {
    throw new Error(`harness ${name} permission 只能是 read-only 或 workspace-write`);
  }
  const profile: HarnessProfile = { name, adapter: raw.adapter, executable: text(raw.executable, "executable"), permission: raw.permission };
  if (raw.useHttp1ForAgent !== undefined) {
    if (raw.adapter !== "cursor-agent" || typeof raw.useHttp1ForAgent !== "boolean") {
      throw new Error("useHttp1ForAgent 仅供 cursor-agent，必须为 boolean");
    }
    profile.useHttp1ForAgent = raw.useHttp1ForAgent;
  }
  if (raw.nativeStallTimeoutMs !== undefined) {
    if (raw.adapter !== "cursor-agent" || typeof raw.nativeStallTimeoutMs !== "number"
      || !Number.isSafeInteger(raw.nativeStallTimeoutMs) || raw.nativeStallTimeoutMs < 30_000 || raw.nativeStallTimeoutMs > 300_000) {
      throw new Error("nativeStallTimeoutMs 仅供 cursor-agent，必须为 30000–300000 的整数");
    }
    profile.nativeStallTimeoutMs = raw.nativeStallTimeoutMs;
  }
  if (raw.useCurrentUserHomeForLogin !== undefined) {
    if (raw.adapter !== "cursor-agent" || typeof raw.useCurrentUserHomeForLogin !== "boolean") {
      throw new Error("useCurrentUserHomeForLogin 仅供 cursor-agent，必须为 boolean");
    }
    profile.useCurrentUserHomeForLogin = raw.useCurrentUserHomeForLogin;
  }
  return profile;
}

function reasoningEffort(value: unknown): CodexReasoningEffort {
  if (value !== "none" && value !== "minimal" && value !== "low" && value !== "medium"
      && value !== "high" && value !== "xhigh" && value !== "max" && value !== "ultra") {
    throw new Error("backend.reasoningEffort 只能是 none、minimal、low、medium、high、xhigh、max 或 ultra");
  }
  return value;
}

export function parseHarnessBackend(raw: Record<string, unknown>): HarnessBackend {
  if (raw.auth === "cursor-login" || raw.auth === "cursor-api-key") {
    const allowed = new Set(raw.auth === "cursor-login" ? ["auth", "model"] : ["auth", "model", "apiKeyEnv"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error(`${raw.auth} backend 不接受 ${key}；Cursor 使用原生服务与认证，不绑定 LLM provider`);
    }
    const model = text(raw.model, "backend.model");
    if (raw.auth === "cursor-login") return { auth: "cursor-login", model };
    const backend: CursorApiKeyBackend = { auth: "cursor-api-key", model };
    if (raw.apiKeyEnv !== undefined) {
      const apiKeyEnv = text(raw.apiKeyEnv, "backend.apiKeyEnv");
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(apiKeyEnv)) throw new Error("backend.apiKeyEnv 必须是环境变量名称");
      backend.apiKeyEnv = apiKeyEnv;
    }
    return backend;
  }
  if (raw.auth === "claude-subscription") {
    const allowed = new Set(["auth", "model", "claudeConfigDir"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error(`claude-subscription backend 不接受 ${key}；请勿混用 API provider 或 Codex 配置`);
    }
    const backend: ClaudeSubscriptionBackend = { auth: "claude-subscription", model: text(raw.model, "backend.model") };
    if (raw.claudeConfigDir !== undefined) backend.claudeConfigDir = text(raw.claudeConfigDir, "backend.claudeConfigDir");
    return backend;
  }
  if (raw.auth === "chatgpt") {
    const allowed = new Set(["auth", "model", "reasoningEffort", "credentialsStore", "codexHome"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error(`chatgpt 订阅 backend 不接受 ${key}；请勿混用 API provider 配置`);
    }
    const backend: CodexSubscriptionBackend = { auth: "chatgpt", model: text(raw.model, "backend.model") };
    if (raw.reasoningEffort !== undefined) backend.reasoningEffort = reasoningEffort(raw.reasoningEffort);
    if (raw.credentialsStore !== undefined) {
      if (raw.credentialsStore !== "file" && raw.credentialsStore !== "keyring" && raw.credentialsStore !== "auto") {
        throw new Error("backend.credentialsStore 只能是 file、keyring 或 auto");
      }
      backend.credentialsStore = raw.credentialsStore;
    }
    if (raw.codexHome !== undefined) backend.codexHome = text(raw.codexHome, "backend.codexHome");
    return backend;
  }
  if (raw.auth !== undefined && raw.auth !== "api-key") throw new Error("backend.auth 只能是 api-key、chatgpt、claude-subscription、cursor-login 或 cursor-api-key");
  for (const key of ["credentialsStore", "codexHome", "claudeConfigDir"]) {
    if (Object.hasOwn(raw, key)) throw new Error(`API key backend 不接受订阅字段 ${key}`);
  }
  for (const key of ["cursorConfigDir", "apiKeyEnv"]) {
    if (Object.hasOwn(raw, key)) throw new Error(`API key provider backend 不接受字段 ${key}`);
  }
  if (raw.protocol !== "anthropic-messages" && raw.protocol !== "responses" && raw.protocol !== "chat-completions") {
    throw new Error("harness backend.protocol 只能是 anthropic-messages、responses 或 chat-completions");
  }
  const backend: ApiKeyHarnessBackend = {
    provider: validateBenchName(text(raw.provider, "backend.provider")),
    model: text(raw.model, "backend.model"), protocol: raw.protocol,
  };
  if (raw.auth !== undefined) backend.auth = raw.auth;
  if (raw.reasoningEffort !== undefined) backend.reasoningEffort = reasoningEffort(raw.reasoningEffort);
  return backend;
}

export function loadTarget(root: string, name: string): Target {
  const raw = json(root, "targets", name);
  if (raw.kind === "llm") {
    const target: Target = { name, kind: "llm", config: validateBenchName(text(raw.config, "config")) };
    if (raw.system !== undefined) {
      if (typeof raw.system !== "string") throw new Error("system 必须是预设名或空字符串");
      target.system = raw.system === "" ? "" : validateBenchName(raw.system);
    }
    return target;
  }
  if (raw.kind !== "harness" || !record(raw.backend)) {
    throw new Error(`target ${name} 需要 kind=llm 或 kind=harness 与 backend`);
  }
  return {
    name, kind: "harness", harness: validateBenchName(text(raw.harness, "harness")),
    backend: parseHarnessBackend(raw.backend),
  };
}

function parseCheck(root: string, value: unknown): TaskCheck {
  if (!record(value)) throw new Error("check 必须是对象");
  if (value.kind === "output-contains" || value.kind === "output-equals") {
    if (typeof value.text !== "string" || value.text === "") throw new Error("check.text 必须是非空文本");
    return { kind: value.kind, text: value.text };
  }
  if (value.kind === "file-exists" || value.kind === "file-contains") {
    const filePath = validateRelativePath(text(value.path, "check.path"));
    if (value.kind === "file-exists") return { kind: value.kind, path: filePath };
    if (typeof value.text !== "string" || value.text === "") throw new Error("check.text 必须是非空文本");
    return { kind: value.kind, path: filePath, text: value.text };
  }
  if (value.kind === "command") {
    if (!Array.isArray(value.argv) || value.argv.length === 0
        || !value.argv.every((part): part is string => typeof part === "string" && !part.includes("\u0000"))
        || value.argv[0] === "") {
      throw new Error("command check.argv 必须是非空的字符串数组");
    }
    return { kind: value.kind, argv: value.argv, timeoutMs: positiveInteger(value.timeoutMs, 10_000, "check.timeoutMs") };
  }
  if (value.kind === "script") {
    const file = text(value.file, "script check.file");
    const absolute = resolveProjectPath(root, file);
    if (!file.endsWith(".mjs") || !lstatSync(absolute).isFile()) throw new Error("script check.file 必须是项目内的 .mjs 文件");
    const source = readFileSync(absolute, "utf8").replace(/^\uFEFF/u, "");
    if (source.trim() === "") throw new Error("script check.file 不能为空");
    // Source is frozen into the existing command representation. Old specs need no new runtime support.
    return {
      kind: "command", argv: [process.execPath, "--input-type=module", "-e", source],
      timeoutMs: positiveInteger(value.timeoutMs, 10_000, "check.timeoutMs"),
    };
  }
  throw new Error(`未知 check.kind：${String(value.kind)}`);
}

function manifestPattern(value: unknown): string {
  const pattern = text(value, "manifest 路径");
  const relative = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  validateRelativePath(relative);
  if (relative.includes("*") || relative.split("/").some((part) => part === "." || part === ".git" || part === "node_modules"
      || part === "archives" || part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))) {
    throw new Error(`manifest 仅支持安全的精确文件路径或 dir/**：${pattern}`);
  }
  return pattern;
}

function parseManifest(value: unknown): TaskManifest {
  if (!record(value)) throw new Error("task manifest 必须是对象");
  const manifest: TaskManifest = {};
  for (const key of ["immutable", "editable"] as const) {
    const values = value[key];
    if (values === undefined) continue;
    if (!Array.isArray(values)) throw new Error(`manifest.${key} 必须是路径数组`);
    manifest[key] = [...new Set(values.map(manifestPattern))];
  }
  if (value.allowNewFiles !== undefined) {
    if (typeof value.allowNewFiles !== "boolean") throw new Error("manifest.allowNewFiles 必须是布尔值");
    manifest.allowNewFiles = value.allowNewFiles;
  }
  if (Object.keys(manifest).length === 0) throw new Error("manifest 不能是空对象");
  return manifest;
}

function selfTestCase(root: string, value: unknown): TaskSelfTestCase {
  if (!record(value) || (value.files === undefined && value.output === undefined)) throw new Error("selfTest 用例需要 files 或 output");
  const result: TaskSelfTestCase = {};
  if (value.files !== undefined) {
    const relative = text(value.files, "selfTest.files");
    if (!lstatSync(resolveProjectPath(root, relative)).isDirectory()) throw new Error("selfTest.files 必须是项目内的 overlay 目录");
    result.files = relative;
  }
  if (value.output !== undefined) {
    if (typeof value.output !== "string") throw new Error("selfTest.output 必须是文本");
    result.output = value.output;
  }
  return result;
}

function parseSelfTest(root: string, value: unknown): TaskSelfTest {
  if (!record(value) || (value.initial !== "pass" && value.initial !== "fail")) throw new Error("selfTest.initial 必须是 pass 或 fail");
  if (!Array.isArray(value.negative) || value.negative.length === 0) throw new Error("selfTest.negative 至少需要一个负例");
  const negative = value.negative.map((entry: unknown) => {
    if (!record(entry)) throw new Error("selfTest.negative 必须是对象数组");
    return { name: validateBenchName(text(entry.name, "selfTest.negative.name")), ...selfTestCase(root, entry) };
  });
  if (new Set(negative.map((entry) => entry.name)).size !== negative.length) throw new Error("selfTest.negative.name 不可重复");
  return { initial: value.initial, reference: selfTestCase(root, value.reference), negative };
}

export function loadTask(root: string, name: string): BenchTask {
  const raw = json(root, "tasks", name);
  if ((raw.prompt === undefined) === (raw.promptFile === undefined)) {
    throw new Error("task 必须且只能提供 prompt 或 promptFile");
  }
  const prompt = raw.promptFile !== undefined
    ? readFileSync(resolveProjectPath(root, text(raw.promptFile, "promptFile")), "utf8").replace(/^\uFEFF/u, "")
    : raw.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("task prompt 不能为空");
  if (raw.checks !== undefined && !Array.isArray(raw.checks)) throw new Error("task checks 必须是数组");
  const task: BenchTask = {
    name, prompt, timeoutMs: positiveInteger(raw.timeoutMs, 120_000, "task.timeoutMs"),
    checks: (raw.checks ?? []).map((check: unknown) => parseCheck(root, check)),
  };
  if (raw.fixture !== undefined) {
    const fixture = text(raw.fixture, "fixture");
    const directory = resolveProjectPath(root, fixture);
    if (!lstatSync(directory).isDirectory()) throw new Error("task fixture 必须是目录");
    task.fixture = fixture;
  }
  if (raw.requires !== undefined) {
    if (raw.requires !== "workspace-write") throw new Error("task.requires 只能是 workspace-write");
    task.requires = raw.requires;
  }
  if (raw.manifest !== undefined) {
    task.manifest = parseManifest(raw.manifest);
    task.checks.push(freezeManifestCheck(task.fixture === undefined ? undefined : resolveProjectPath(root, task.fixture), task.manifest));
  }
  if (raw.selfTest !== undefined) {
    task.selfTest = parseSelfTest(root, raw.selfTest);
    const fixture = task.fixture === undefined ? undefined : resolveProjectPath(root, task.fixture);
    if (fixture !== undefined) {
      for (const entry of [task.selfTest.reference, ...task.selfTest.negative]) {
        if (entry.files === undefined) continue;
        const directory = resolveProjectPath(root, entry.files);
        if (directory === fixture || directory.startsWith(`${fixture}${path.sep}`) || fixture.startsWith(`${directory}${path.sep}`)) {
          throw new Error("selfTest overlay 与 fixture 目录不能重叠；参考解不得进入候选工作区");
        }
      }
    }
  }
  return task;
}

/** Old tasks without an explicit requirement retain their original permissive behavior. */
export function validateTaskTarget(task: BenchTask, target: ResolvedTarget): void {
  if (task.requires === "workspace-write" && (target.kind === "llm" || target.profile.permission !== "workspace-write")) {
    throw new Error(`任务 ${task.name} 需要 workspace-write；target ${target.name} 必须使用可写 harness`);
  }
}

function safeSystemText(root: string, name: string): string {
  if (name === "") return "";
  const relative = existsSync(path.join(root, "prompts", "system", `${name}.md`))
    ? `prompts/system/${name}.md` : `prompts/system/${name}.txt`;
  resolveProjectPath(root, relative);
  return resolveSystemText(root, name);
}

export function resolveTarget(root: string, name: string): ResolvedTarget {
  const definition = loadTarget(root, name);
  return resolveTargetDefinition(root, definition);
}

/** Resolve an already parsed definition, including targets being authored before their first write. */
export function resolveTargetDefinition(root: string, definition: Target): ResolvedTarget {
  const name = definition.name;
  if (definition.kind === "llm") {
    // 防止旧配置读取器接受路径穿越；不接触 .env 或密钥内容。
    if (existsSync(path.join(root, "configs", `${definition.config}.json`))) {
      resolveProjectPath(root, `configs/${definition.config}.json`);
    }
    const peek = peekConfigRef(root, definition.config);
    return {
      name, kind: "llm", definition, config: peek.snapshot, apiKeyEnv: peek.apiKeyEnv,
      systemText: safeSystemText(root, definition.system ?? "default"),
    };
  }
  const profile = loadHarness(root, definition.harness);
  if (isCursorBackend(definition.backend)) {
    if (profile.adapter !== "cursor-agent") throw new Error(`${definition.backend.auth} backend 仅支持 cursor-agent harness`);
    return {
      name, kind: "harness", definition, profile,
      backend: definition.backend.auth === "cursor-api-key"
        ? { ...definition.backend, apiKeyEnv: definition.backend.apiKeyEnv ?? "CURSOR_API_KEY" }
        : { ...definition.backend },
    };
  }
  if (isClaudeSubscriptionBackend(definition.backend)) {
    if (profile.adapter !== "claude-code") throw new Error("claude-subscription backend 仅支持 claude-code harness");
    if (definition.backend.claudeConfigDir === undefined && process.env.CLAUDE_CONFIG_DIR
      && !path.isAbsolute(process.env.CLAUDE_CONFIG_DIR)) {
      throw new Error("当前 CLAUDE_CONFIG_DIR 必须是绝对路径；请在原生 CLI 中使用固定绝对目录登录后再运行订阅 target");
    }
    // Freeze only the native config path; credentials remain owned by Claude Code.
    const claudeConfigDirMode = definition.backend.claudeConfigDir !== undefined || Boolean(process.env.CLAUDE_CONFIG_DIR)
      ? "explicit" : "default";
    const claudeConfigDir = definition.backend.claudeConfigDir !== undefined
      ? path.resolve(root, definition.backend.claudeConfigDir)
      : process.env.CLAUDE_CONFIG_DIR
        // Preserve the spelling: even a trailing slash contributes to native Keychain identity.
        ? text(process.env.CLAUDE_CONFIG_DIR, "CLAUDE_CONFIG_DIR")
        : path.join(homedir(), ".claude");
    return { name, kind: "harness", definition, profile, backend: { ...definition.backend, claudeConfigDir, claudeConfigDirMode } };
  }
  if (isCodexSubscriptionBackend(definition.backend)) {
    if (profile.adapter !== "codex") throw new Error("chatgpt 订阅 backend 仅支持 codex harness");
    // Resolve only the path. Reading login state is an explicit execution/preflight step.
    const codexHome = definition.backend.codexHome !== undefined
      ? path.resolve(root, definition.backend.codexHome)
      : process.env.CODEX_HOME
        ? path.resolve(text(process.env.CODEX_HOME, "CODEX_HOME"))
        : path.join(homedir(), ".codex");
    return {
      name, kind: "harness", definition, profile,
      backend: { ...definition.backend, codexHome, credentialsStore: definition.backend.credentialsStore ?? "auto" },
    };
  }
  if (definition.backend.reasoningEffort !== undefined && profile.adapter !== "codex") {
    throw new Error("backend.reasoningEffort 仅支持 codex harness；不会静默忽略设置");
  }
  const required = HARNESS_PROTOCOLS[profile.adapter];
  if (required === undefined) throw new Error("cursor-agent 需要显式 cursor-login 或 cursor-api-key backend，不接受 LLM provider backend");
  if (definition.backend.protocol !== required) {
    throw new Error(`${profile.adapter} 需要 ${required} 协议，收到 ${definition.backend.protocol}`);
  }
  resolveProjectPath(root, `providers/${definition.backend.provider}.json`);
  const provider = loadProvider(root, definition.backend.provider);
  const baseURL = provider.endpoints?.[required];
  if (baseURL === undefined) {
    throw new Error(`provider ${definition.backend.provider} 未显式声明 endpoints.${required}；不会自动转换协议`);
  }
  const apiKeyEnv = text(provider.apiKeyEnv, "provider.apiKeyEnv");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(apiKeyEnv)) throw new Error("provider.apiKeyEnv 必须是环境变量名称");
  return { name, kind: "harness", definition, profile, backend: { ...definition.backend, baseURL, apiKeyEnv } };
}
