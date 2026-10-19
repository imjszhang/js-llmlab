import type { Completer } from "../client.ts";
import type { ConfigSnapshot, TokenUsage } from "../../types.ts";

/** Harnesses may report only a total; unknown input/output splits stay null. */
export type BenchCost = { input: number | null; output: number | null; total: number; currency: string };

export type HarnessAdapter = "claude-code" | "codex" | "deepseek-harness" | "opencode" | "cursor-agent";
export type HarnessProtocol = "anthropic-messages" | "responses" | "chat-completions";
export type HarnessContext = { workspace: string; home: string; prompt: string; timeoutMs: number };
export type HarnessProfile = {
  name: string;
  adapter: HarnessAdapter;
  executable: string;
  permission: "read-only" | "workspace-write";
  /** Explicit opt-in; missing preserves legacy permissions and process limits. */
  execution?: {
    fullAccess?: boolean;
    proxy?: "inherit" | "claude-shell";
    maxOutputBytes?: number;
    pinModelAliases?: boolean;
  };
  /** Cursor's native HTTP/1.1 SSE transport; absent preserves native default. */
  useHttp1ForAgent?: boolean;
  /** Version/hash-pinned local compatibility for slow native image messages. */
  nativeStallTimeoutMs?: number;
  /** Explicitly retain the native user HOME for Cursor login, while isolating config/data and tool shells. */
  useCurrentUserHomeForLogin?: boolean;
};
export type LlmTarget = { name: string; kind: "llm"; config: string; system?: string };
export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type CodexCredentialsStore = "file" | "keyring" | "auto";
export type ApiKeyHarnessBackend = {
  provider: string;
  model: string;
  protocol: HarnessProtocol;
  /** Absent on legacy definitions and snapshots. */
  auth?: "api-key";
  reasoningEffort?: CodexReasoningEffort;
  credentialsStore?: never;
  codexHome?: never;
  claudeConfigDir?: never;
};
export type CodexSubscriptionBackend = {
  auth: "chatgpt";
  model: string;
  reasoningEffort?: CodexReasoningEffort;
  credentialsStore?: CodexCredentialsStore;
  codexHome?: string;
  claudeConfigDir?: never;
  provider?: never;
  protocol?: never;
  baseURL?: never;
  apiKeyEnv?: never;
  pricing?: never;
};
export type ClaudeSubscriptionBackend = {
  auth: "claude-subscription";
  model: string;
  claudeConfigDir?: string;
  provider?: never;
  protocol?: never;
  baseURL?: never;
  apiKeyEnv?: never;
  pricing?: never;
  codexHome?: never;
  credentialsStore?: never;
  reasoningEffort?: never;
};
type CursorBackendFields = {
  model: string;
  provider?: never;
  protocol?: never;
  baseURL?: never;
  pricing?: never;
  codexHome?: never;
  claudeConfigDir?: never;
  credentialsStore?: never;
  reasoningEffort?: never;
};
/** Native Cursor login is owned by the CLI; no credential/config directory is selected here. */
export type CursorLoginBackend = CursorBackendFields & { auth: "cursor-login"; apiKeyEnv?: never };
export type CursorApiKeyBackend = CursorBackendFields & { auth: "cursor-api-key"; apiKeyEnv?: string };
export type CursorBackend = CursorLoginBackend | CursorApiKeyBackend;
export type SubscriptionBackend = CodexSubscriptionBackend | ClaudeSubscriptionBackend | CursorLoginBackend;
export type HarnessBackend = ApiKeyHarnessBackend | SubscriptionBackend | CursorApiKeyBackend;
export type ResolvedApiKeyHarnessBackend = ApiKeyHarnessBackend & { baseURL: string; apiKeyEnv: string };
export type ResolvedCodexSubscriptionBackend = CodexSubscriptionBackend & {
  codexHome: string;
  credentialsStore: CodexCredentialsStore;
};
export type ResolvedClaudeSubscriptionBackend = ClaudeSubscriptionBackend & {
  claudeConfigDir: string;
  /** Native keychain namespaces differ when CLAUDE_CONFIG_DIR is explicitly set. */
  claudeConfigDirMode: "default" | "explicit";
};
export type ResolvedCursorLoginBackend = CursorLoginBackend;
export type ResolvedCursorApiKeyBackend = CursorApiKeyBackend & { apiKeyEnv: string };
export type ResolvedCursorBackend = ResolvedCursorLoginBackend | ResolvedCursorApiKeyBackend;
export type ResolvedHarnessBackend = ResolvedApiKeyHarnessBackend | ResolvedCodexSubscriptionBackend | ResolvedClaudeSubscriptionBackend | ResolvedCursorBackend;
export type HarnessTarget = {
  name: string;
  kind: "harness";
  harness: string;
  backend: HarnessBackend;
};
export type Target = LlmTarget | HarnessTarget;
export type TaskCheck =
  | { kind: "output-contains"; text: string }
  | { kind: "output-equals"; text: string }
  | { kind: "file-exists"; path: string }
  | { kind: "file-contains"; path: string; text: string }
  | { kind: "command"; argv: string[]; timeoutMs: number };
/** Exact paths or a directory subtree written as dir/**. Constraints are frozen as command checks. */
export type TaskManifest = { immutable?: string[]; editable?: string[]; allowNewFiles?: boolean };
export type TaskSelfTestCase = { files?: string; output?: string };
export type TaskSelfTest = {
  initial: "pass" | "fail";
  reference: TaskSelfTestCase;
  negative: Array<TaskSelfTestCase & { name: string }>;
};
export type BenchTask = {
  name: string;
  prompt: string;
  fixture?: string;
  timeoutMs: number;
  checks: TaskCheck[];
  requires?: "workspace-write";
  manifest?: TaskManifest;
  selfTest?: TaskSelfTest;
};
export type ResolvedLlmTarget = {
  name: string;
  kind: "llm";
  definition: LlmTarget;
  config: ConfigSnapshot;
  apiKeyEnv: string;
  systemText: string;
};
export type ResolvedHarnessTarget = {
  name: string;
  kind: "harness";
  definition: HarnessTarget;
  profile: HarnessProfile;
  backend: ResolvedHarnessBackend;
};
export type ResolvedTarget = ResolvedLlmTarget | ResolvedHarnessTarget;
export type FixtureFile = { path: string; sha256: string; bytes: number; mode: number };
export type FixtureSnapshot = { hash: string; files: FixtureFile[] };
export type FileChange = { path: string; kind: "added" | "modified" | "deleted"; before: string | null; after: string | null };

export type ProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Allow a harness to dispose its own managed tool process ranges before force-kill. */
  terminationGraceMs?: number;
};
export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  latencyMs: number;
};
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export type HarnessPlan = {
  process: ProcessRequest;
  files: Array<{ path: string; content: string; mode?: 0o600 | 0o700 }>;
  route: HarnessProtocol | "cursor-agent";
};
export type ExecutionEvent = {
  type: "session" | "message" | "tool" | "usage" | "error" | "raw";
  data: unknown;
};
export type ParsedHarnessResult = {
  status: "completed" | "failed" | "timeout";
  text: string;
  reasoning: string | null;
  usage: TokenUsage | null;
  cost: BenchCost | null;
  sessionId: string | null;
  responseModel: string | null;
  events: ExecutionEvent[];
  error: string | null;
};
export type ExecutionResult = ParsedHarnessResult & {
  latencyMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  raw: unknown;
  harnessVersion: string | null;
  usageSource: "request" | "run-total" | null;
  costSource: "configured-pricing" | "harness-reported" | null;
};
export type GradeResult = {
  status: "passed" | "failed" | "not-run" | "error";
  checks: Array<{ check: TaskCheck; passed: boolean; detail: string; stdout?: string; stderr?: string }>;
};
export type ExecutionInput = {
  root: string;
  target: ResolvedTarget;
  task: BenchTask;
  workspace: string;
  home: string;
};
export type ExecutorDeps = { complete?: Completer; runProcess?: ProcessRunner };
export type BenchRunRecord = {
  schemaVersion: 1;
  target: ResolvedTarget;
  task: string;
  sample: number;
  startedAt: string;
  workspace: string;
  home: string;
  execution: ExecutionResult;
  grade: GradeResult;
  changes: FileChange[];
};
export type BenchSpec = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  task: BenchTask;
  targets: ResolvedTarget[];
  repeat: number;
  concurrency: number;
  fixture: FixtureSnapshot;
};
