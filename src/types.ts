export type ConfigSnapshot = {
  name: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
};

export type NamedConfigFile = {
  name?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  apiKeyEnv?: string;
};

export type CliConfigOverrides = {
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
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
};

export type NodeMessages = {
  system: string;
  user: string;
  assistant: string;
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
  temperature?: string;
  maxTokens?: string;
  from?: string;
};
