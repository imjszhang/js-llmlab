export type ThinkingMode = "enabled" | "disabled";
export type ReasoningEffort = "low" | "high" | "max";

/** 每百万 token 的价格。推理 token 已含在 completion_tokens 里，按 output 计。 */
export type Pricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
};

/** 一次调用的花费；无 pricing 时节点里是 null。 */
export type Cost = {
  input: number;
  output: number;
  total: number;
  currency: string;
};

export type ConfigSnapshot = {
  name: string;
  provider: string | null;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  thinking: ThinkingMode | null;
  reasoningEffort: ReasoningEffort | null;
  /** 单次请求超时（ms），交给 SDK；缺省 600000。 */
  timeoutMs: number;
  /** 失败后在我们这一层重试的次数（SDK 自身重试关掉）；缺省 2。 */
  maxRetries: number;
  /** 没配价格就没有这个 key。 */
  pricing?: Pricing;
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
  timeoutMs?: number;
  maxRetries?: number;
  pricing?: Pricing;
};

export type CliConfigOverrides = {
  provider?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
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
  cost: Cost | null;
  /** 网关响应头 `x-request-id`；没返回或老节点为 null。 */
  requestId: string | null;
};

/**
 * 一次调用的原始材料，落在 `nodes/<id>.raw.json`，查网关怪癖用。
 * 请求体不含密钥；写盘前还会把当前 apiKey 字符串整体打码兜底。
 */
export type RawCapture = {
  /** 发出去的请求体（`buildChatRequest` 的产物）。 */
  request: Record<string, unknown>;
  /** 非流式：完整响应对象；流式：拼接后的最终对象；失败：null。 */
  response: unknown;
  /** 流式收到的 chunk 数；非流式 / 失败为 null。 */
  chunkCount: number | null;
  requestId: string | null;
  systemFingerprint: string | null;
  /** 响应头里所有像 id 的（request / trace / ray）；失败或假 completer 可为空对象。 */
  headers: Record<string, string>;
  /** 失败时的错误对象序列化（name / message / status / body …）；成功为 null。 */
  error: Record<string, unknown> | null;
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
  cost: Cost | null;
  requestId: string | null;
};

/** LLM 裁判对一路的裁决。解析失败或请求失败时 `score` 为 null、`error` 有值。 */
export type JudgeVerdict = {
  score: number | null;
  reason: string | null;
  error: string | null;
  /** 裁判调用落在会话树里的节点。 */
  nodeId: string | null;
  usage: TokenUsage | null;
  latencyMs: number;
};

/** 本次裁判用的配置、rubric 与会话。 */
export type JudgeInfo = {
  config: ConfigSnapshot;
  rubric: string;
  sessionId: string;
};

/** `compare score` 对一路的指标。 */
export type VariantScore = {
  configName: string;
  /** 与参考答案的相似度，0–1；没给 `--reference` 时为 null。 */
  similarity: number | null;
  /** 相对基线（缺省 spec.input）的改动比例，0–1。 */
  changeRatio: number;
  /** changeRatio < 0.05，几乎没改。 */
  barelyChanged: boolean;
  /** 带 `--judge` 时才有。 */
  judge?: JudgeVerdict;
};

export type ComparisonScores = {
  comparisonId: string;
  /** 参考答案文件路径，或 null。 */
  reference: string | null;
  /** 基线文件路径；null 表示用 spec.input。 */
  baseline: string | null;
  scoredAt: string;
  variants: VariantScore[];
  /** 带 `--judge` 时才有。 */
  judge?: JudgeInfo;
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
  timeoutMs?: string;
  maxRetries?: string;
  from?: string;
  /** 只打印解析后的配置与请求体，不发请求、不落盘。 */
  dryRun?: boolean;
  /** compare 并发路数，缺省 3。 */
  concurrency?: string;
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
