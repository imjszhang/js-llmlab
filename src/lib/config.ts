import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type {
  CliConfigOverrides,
  ConfigPeek,
  ConfigSnapshot,
  NamedConfigFile,
  ResolvedConfig,
  SharedCliOptions,
} from "../types.ts";
import { getConfigsDir } from "./paths.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TEMPERATURE = 1;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";

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
  const baseURL = optionalString(raw.baseURL);
  const model = optionalString(raw.model);
  const temperature = optionalNumber(raw.temperature);
  const maxTokens = optionalNumber(raw.maxTokens);
  const apiKeyEnv = optionalString(raw.apiKeyEnv);
  if (name !== undefined) parsed.name = name;
  if (baseURL !== undefined) parsed.baseURL = baseURL;
  if (model !== undefined) parsed.model = model;
  if (temperature !== undefined) parsed.temperature = temperature;
  if (maxTokens !== undefined) parsed.maxTokens = maxTokens;
  if (apiKeyEnv !== undefined) parsed.apiKeyEnv = apiKeyEnv;
  return parsed;
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
  const dir = getConfigsDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

function envDefaults(): NamedConfigFile {
  const defaults: NamedConfigFile = {
    name: "env",
    apiKeyEnv: DEFAULT_API_KEY_ENV,
  };
  const baseURL = optionalString(process.env.OPENAI_BASE_URL) ?? DEFAULT_BASE_URL;
  const model = optionalString(process.env.OPENAI_MODEL) ?? DEFAULT_MODEL;
  const temperature = parseNumber(process.env.OPENAI_TEMPERATURE) ?? DEFAULT_TEMPERATURE;
  const maxTokens = parseNumber(process.env.OPENAI_MAX_TOKENS) ?? DEFAULT_MAX_TOKENS;
  defaults.baseURL = baseURL;
  defaults.model = model;
  defaults.temperature = temperature;
  defaults.maxTokens = maxTokens;
  return defaults;
}

function mergeConfig(
  base: NamedConfigFile,
  overlay: NamedConfigFile,
): NamedConfigFile {
  const merged: NamedConfigFile = { ...base };
  if (overlay.name !== undefined) merged.name = overlay.name;
  if (overlay.baseURL !== undefined) merged.baseURL = overlay.baseURL;
  if (overlay.model !== undefined) merged.model = overlay.model;
  if (overlay.temperature !== undefined) merged.temperature = overlay.temperature;
  if (overlay.maxTokens !== undefined) merged.maxTokens = overlay.maxTokens;
  if (overlay.apiKeyEnv !== undefined) merged.apiKeyEnv = overlay.apiKeyEnv;
  return merged;
}

function requireField(value: string | undefined, field: string): string {
  if (value === undefined || value === "") {
    throw new Error(`配置缺少 ${field}`);
  }
  return value;
}

function finalizeSnapshot(merged: NamedConfigFile, fallbackName: string): ConfigSnapshot {
  return {
    name: merged.name ?? fallbackName,
    baseURL: requireField(merged.baseURL, "baseURL"),
    model: requireField(merged.model, "model"),
    temperature: merged.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: merged.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export function peekConfig(
  root: string,
  name?: string,
  overrides: CliConfigOverrides = {},
): ConfigPeek {
  let merged = envDefaults();
  if (name !== undefined) {
    merged = mergeConfig(merged, loadNamedConfig(root, name));
    if (merged.name === undefined) {
      merged.name = name;
    }
  }
  merged = mergeConfig(merged, overrides);
  const snapshot = finalizeSnapshot(merged, name ?? "env");
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
  const peeked = peekConfig(root, name, overrides);
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

export function toSnapshot(config: ResolvedConfig): ConfigSnapshot {
  return {
    name: config.name,
    baseURL: config.baseURL,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

export function overridesFromCli(options: SharedCliOptions): CliConfigOverrides {
  const overrides: CliConfigOverrides = {};
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
