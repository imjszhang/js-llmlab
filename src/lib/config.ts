import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type {
  CliConfigOverrides,
  ConfigPeek,
  ConfigRefPeek,
  ConfigSnapshot,
  NamedConfigFile,
  Pricing,
  ReasoningEffort,
  ResolvedConfig,
  SharedCliOptions,
  ThinkingMode,
} from "../types.ts";
import { getConfigsDir, getProvidersDir, getSuitesDir } from "./paths.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_PROVIDER = "llmcore";

export function loadEnv(root: string): void {
  loadDotenv({ path: path.join(root, ".env"), quiet: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseNamedConfig(raw: unknown): NamedConfigFile {
  if (!isRecord(raw)) {
    throw new Error("配置文件必须是 JSON 对象");
  }
  const parsed: NamedConfigFile = {};
  const name = optionalString(raw.name);
  const provider = optionalString(raw.provider);
  const baseURL = optionalString(raw.baseURL);
  const model = optionalString(raw.model);
  const temperature = optionalNumber(raw.temperature);
  const maxTokens = optionalNumber(raw.maxTokens);
  const apiKeyEnv = optionalString(raw.apiKeyEnv);
  const thinking = parseThinkingMode(raw.thinking);
  const reasoningEffort = parseReasoningEffort(raw.reasoningEffort);
  const pricing = parsePricing(raw.pricing);
  if (name !== undefined) parsed.name = name;
  if (provider !== undefined) parsed.provider = provider;
  if (baseURL !== undefined) parsed.baseURL = baseURL;
  if (model !== undefined) parsed.model = model;
  if (temperature !== undefined) parsed.temperature = temperature;
  if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
  if (apiKeyEnv !== undefined) parsed.apiKeyEnv = apiKeyEnv;
  if (thinking !== undefined) parsed.thinking = thinking;
  if (reasoningEffort !== undefined) parsed.reasoningEffort = reasoningEffort;
  if (pricing !== undefined) parsed.pricing = pricing;
  return parsed;
}

/** `pricing: { inputPerMillion, outputPerMillion, currency? }`，currency 缺省 CNY。 */
export function parsePricing(value: unknown): Pricing | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("pricing 必须是对象：{ inputPerMillion, outputPerMillion, currency }");
  }
  const inputPerMillion = optionalNumber(value.inputPerMillion);
  const outputPerMillion = optionalNumber(value.outputPerMillion);
  if (inputPerMillion === undefined || outputPerMillion === undefined || inputPerMillion < 0 || outputPerMillion < 0) {
    throw new Error("pricing.inputPerMillion 与 pricing.outputPerMillion 必须是 ≥ 0 的数字");
  }
  return {
    inputPerMillion,
    outputPerMillion,
    currency: optionalString(value.currency) ?? "CNY",
  };
}

export function parseThinkingMode(value: unknown): ThinkingMode | undefined {
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  throw new Error(`thinking 只能是 enabled 或 disabled，收到 ${String(value)}`);
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === "low" || value === "high" || value === "max") {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  throw new Error(`reasoningEffort 只能是 low、high 或 max，收到 ${String(value)}`);
}

export function loadNamedConfig(root: string, name: string): NamedConfigFile {
  const filePath = path.join(getConfigsDir(root), `${name}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`找不到配置：${name}（期望 ${filePath}）`);
  }
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return parseNamedConfig(raw);
}

export function listConfigs(root: string): string[] {
  return listJsonNames(getConfigsDir(root));
}

export function hasNamedConfig(root: string, name: string): boolean {
  return existsSync(path.join(getConfigsDir(root), `${name}.json`));
}

export function listProviders(root: string): string[] {
  return listJsonNames(getProvidersDir(root));
}

export function hasProvider(root: string, name: string): boolean {
  return existsSync(path.join(getProvidersDir(root), `${name}.json`));
}

export function loadProvider(root: string, name: string): NamedConfigFile {
  const filePath = path.join(getProvidersDir(root), `${name}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`找不到 provider：${name}（期望 ${filePath}）`);
  }
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const parsed = parseNamedConfig(raw);
  if (parsed.name === undefined) {
    parsed.name = name;
  }
  parsed.provider = name;
  return parsed;
}

export function listSuites(root: string): string[] {
  return listJsonNames(getSuitesDir(root));
}

export function loadSuite(root: string, name: string): string[] {
  const filePath = path.join(getSuitesDir(root), `${name}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`找不到 suite：${name}（期望 ${filePath}）`);
  }
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.configs)) {
    throw new Error(`suite ${name} 需要 { "configs": string[] }`);
  }
  return raw.configs
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function listJsonNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export function parseNameList(value: string | undefined): string[] {
  if (value === undefined || value === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

export function collectConfigRefs(
  options: { configs?: string; models?: string; suite?: string },
  root?: string,
): string[] {
  const fromSuite =
    options.suite !== undefined && root !== undefined ? loadSuite(root, options.suite) : [];
  return uniqueNames([
    ...fromSuite,
    ...parseNameList(options.configs),
    ...parseNameList(options.models),
  ]);
}

export function safeVariantName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/gu, "_").replace(/\s+/gu, "_");
  return safe === "" ? "config" : safe;
}

function envDefaults(): NamedConfigFile {
  const defaults: NamedConfigFile = {
    name: "env",
    apiKeyEnv: DEFAULT_API_KEY_ENV,
  };
  const baseURL = optionalString(process.env.OPENAI_BASE_URL);
  const model = optionalString(process.env.OPENAI_MODEL);
  const temperature = parseNumber(process.env.OPENAI_TEMPERATURE);
  const maxTokens = parseNumber(process.env.OPENAI_MAX_TOKENS);
  if (baseURL !== undefined) defaults.baseURL = baseURL;
  if (model !== undefined) defaults.model = model;
  defaults.temperature = temperature ?? DEFAULT_TEMPERATURE;
  defaults.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  return defaults;
}

function mergeConfig(base: NamedConfigFile, overlay: NamedConfigFile): NamedConfigFile {
  const merged: NamedConfigFile = { ...base };
  if (overlay.name !== undefined) merged.name = overlay.name;
  if (overlay.provider !== undefined) merged.provider = overlay.provider;
  if (overlay.baseURL !== undefined) merged.baseURL = overlay.baseURL;
  if (overlay.model !== undefined) merged.model = overlay.model;
  if (overlay.temperature !== undefined) merged.temperature = overlay.temperature;
  if (overlay.maxTokens !== undefined) merged.maxTokens = overlay.maxTokens;
  if (overlay.apiKeyEnv !== undefined) merged.apiKeyEnv = overlay.apiKeyEnv;
  if (overlay.thinking !== undefined) merged.thinking = overlay.thinking;
  if (overlay.reasoningEffort !== undefined) merged.reasoningEffort = overlay.reasoningEffort;
  if (overlay.pricing !== undefined) merged.pricing = overlay.pricing;
  return merged;
}

export function pickProviderName(
  root: string,
  named: NamedConfigFile,
  overrides: CliConfigOverrides,
): string | undefined {
  const candidates = [
    overrides.provider,
    named.provider,
    optionalString(process.env.JS_LLMLAB_PROVIDER),
  ];
  for (const name of candidates) {
    if (name !== undefined) {
      return name;
    }
  }
  if (hasProvider(root, DEFAULT_PROVIDER)) {
    return DEFAULT_PROVIDER;
  }
  return undefined;
}

function finalizeSnapshot(merged: NamedConfigFile, fallbackName: string): ConfigSnapshot {
  const snapshot: ConfigSnapshot = {
    name: merged.name ?? fallbackName,
    provider: merged.provider ?? null,
    baseURL: merged.baseURL ?? DEFAULT_BASE_URL,
    model: merged.model ?? DEFAULT_MODEL,
    temperature: merged.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: merged.maxTokens ?? DEFAULT_MAX_TOKENS,
    thinking: merged.thinking ?? null,
    reasoningEffort: merged.reasoningEffort ?? null,
  };
  if (merged.pricing !== undefined) {
    snapshot.pricing = merged.pricing;
  }
  return snapshot;
}

export function peekConfig(
  root: string,
  name?: string,
  overrides: CliConfigOverrides = {},
): ConfigPeek {
  const named = name !== undefined ? loadNamedConfig(root, name) : {};
  const providerName = pickProviderName(root, named, overrides);
  let merged = envDefaults();
  if (providerName !== undefined) {
    merged = mergeConfig(merged, loadProvider(root, providerName));
    merged.provider = providerName;
  }
  merged = mergeConfig(merged, named);
  if (name !== undefined && merged.name === undefined) {
    merged.name = name;
  }
  const overlay: NamedConfigFile = {};
  if (overrides.baseURL !== undefined) overlay.baseURL = overrides.baseURL;
  if (overrides.model !== undefined) overlay.model = overrides.model;
  if (overrides.temperature !== undefined) overlay.temperature = overrides.temperature;
  if (overrides.maxTokens !== undefined) overlay.maxTokens = overrides.maxTokens;
  if (overrides.thinking !== undefined) overlay.thinking = overrides.thinking;
  if (overrides.reasoningEffort !== undefined) overlay.reasoningEffort = overrides.reasoningEffort;
  merged = mergeConfig(merged, overlay);
  const snapshot = finalizeSnapshot(merged, name ?? providerName ?? "env");
  const apiKeyEnv = merged.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const apiKey = process.env[apiKeyEnv];
  return {
    snapshot,
    apiKeyEnv,
    apiKeyPresent: apiKey !== undefined && apiKey !== "",
  };
}

export function resolveConfig(
  root: string,
  name?: string,
  overrides: CliConfigOverrides = {},
): ResolvedConfig {
  return requireApiKey(peekConfig(root, name, overrides));
}

export function peekConfigRef(
  root: string,
  ref: string,
  overrides: CliConfigOverrides = {},
): ConfigRefPeek {
  if (hasNamedConfig(root, ref)) {
    const peeked = peekConfig(root, ref, overrides);
    return { ...peeked, ref, source: "file" };
  }
  const modelOverrides: CliConfigOverrides = { ...overrides };
  modelOverrides.model = ref;
  const peeked = peekConfig(root, undefined, modelOverrides);
  return {
    snapshot: { ...peeked.snapshot, name: ref },
    apiKeyEnv: peeked.apiKeyEnv,
    apiKeyPresent: peeked.apiKeyPresent,
    ref,
    source: "model",
  };
}

export function resolveConfigRef(
  root: string,
  ref: string,
  overrides: CliConfigOverrides = {},
): ResolvedConfig {
  return requireApiKey(peekConfigRef(root, ref, overrides));
}

function requireApiKey(peeked: ConfigPeek): ResolvedConfig {
  const apiKey = process.env[peeked.apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      `缺少 API Key：请设置环境变量 ${peeked.apiKeyEnv}（可复制 .env.example 为 .env）`,
    );
  }
  return {
    ...peeked.snapshot,
    apiKey,
    apiKeyEnv: peeked.apiKeyEnv,
  };
}

export function describeNamedConfigs(root: string): ConfigRefPeek[] {
  return listConfigs(root).map((name) => peekConfigRef(root, name));
}

export function describeProviders(root: string): ConfigPeek[] {
  return listProviders(root).map((name) => peekConfig(root, undefined, { provider: name }));
}

export function compareOverridesFromCli(options: SharedCliOptions): CliConfigOverrides {
  const overrides = overridesFromCli(options);
  const result: CliConfigOverrides = {};
  if (overrides.provider !== undefined) result.provider = overrides.provider;
  if (overrides.baseURL !== undefined) result.baseURL = overrides.baseURL;
  if (overrides.temperature !== undefined) result.temperature = overrides.temperature;
  if (overrides.maxTokens !== undefined) result.maxTokens = overrides.maxTokens;
  if (overrides.thinking !== undefined) result.thinking = overrides.thinking;
  if (overrides.reasoningEffort !== undefined) result.reasoningEffort = overrides.reasoningEffort;
  return result;
}

export function toSnapshot(config: ResolvedConfig): ConfigSnapshot {
  const snapshot: ConfigSnapshot = {
    name: config.name,
    provider: config.provider,
    baseURL: config.baseURL,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
  };
  if (config.pricing !== undefined) {
    snapshot.pricing = config.pricing;
  }
  return snapshot;
}

export function overridesFromCli(options: SharedCliOptions): CliConfigOverrides {
  const overrides: CliConfigOverrides = {};
  if (options.provider !== undefined) {
    overrides.provider = options.provider;
  }
  if (options.model !== undefined) {
    overrides.model = options.model;
  }
  const temperature = parseNumber(options.temperature);
  if (temperature !== undefined) {
    overrides.temperature = temperature;
  }
  const maxTokens = parseNumber(options.maxTokens);
  if (maxTokens !== undefined) {
    overrides.maxTokens = maxTokens;
  }
  const thinking = parseThinkingMode(options.thinking);
  if (thinking !== undefined) {
    overrides.thinking = thinking;
  }
  const reasoningEffort = parseReasoningEffort(options.reasoningEffort);
  if (reasoningEffort !== undefined) {
    overrides.reasoningEffort = reasoningEffort;
  }
  return overrides;
}

export function maskSecret(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "未设置";
  }
  if (value.length <= 4) {
    return "已设置 (****)";
  }
  return `已设置 (***${value.slice(-4)})`;
}
