export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

export type ConfigSnapshot = {
  name: string;
  provider: string | null;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  thinking: ThinkingMode | null;
  reasoningEffort: ReasoningEffort | null;
};

export type NamedConfigFile = {
  name?: string;
  provider?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  apiKeyEnv?: string;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
};

export type CliConfigOverrides = {
  provider?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
};

export type ResolvedConfig = ConfigSnapshot & {
  apiKey: string;
  apiKeyEnv: string;
};

export type ConfigPeek = {
  snapshot: ConfigSnapshot;
  apiKeyEnv: string;
  apiKeyPresent: boolean;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number | null;
};

export type NodeMessages = {
  system: string;
  user: string;
  assistant: string;
  reasoning: string | null;
};

export type SessionNode = {
  id: string;
  parentId: string | null;
  createdAt: string;
  config: ConfigSnapshot;
  systemPreset: string | null;
  userPreset: string | null;
  messages: NodeMessages;
  usage: TokenUsage | null;
  latencyMs: number;
  error: string | null;
};

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  defaultConfig: string;
  defaultSystem: string | null;
};

export type BranchRecord = {
  name: string;
  head: string | null;
  createdFrom: string | null;
};

export type ComparisonSpec = {
  id: string;
  createdAt: string;
  configs: string[];
  systemPreset: string | null;
  userPreset: string | null;
  input: string;
  sessionId: string | null;
  fromNodeId: string | null;
};

export type ComparisonVariant = {
  configName: string;
  config: ConfigSnapshot;
  assistant: string;
  reasoning: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
  error: string | null;
  nodeId: string | null;
};

export type SharedCliOptions = {
  session?: string;
  branch?: string;
  config?: string;
  system?: string;
  user?: string;
  message?: string;
  input?: string;
  model?: string;
  models?: string;
  configs?: string;
  provider?: string;
  suite?: string;
  temperature?: string;
  maxTokens?: string;
  thinking?: string;
  reasoningEffort?: string;
  from?: string;
  /** 只打印解析后的配置与请求体，不发请求、不落盘。 */
  dryRun?: boolean;
};

/** `--dry-run` 的一路输出：配置快照、密钥状态、消息与将发送的请求体。 */
export type DryRunEntry = {
  ref: string;
  config: ConfigSnapshot;
  apiKeyEnv: string;
  apiKeyPresent: boolean;
  messages: ChatMessage[];
  request: Record<string, unknown>;
};

export type ConfigRefSource = "file" | "model";

export type ConfigRefPeek = ConfigPeek & {
  ref: string;
  source: ConfigRefSource;
};
