import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadHarness, parseHarnessBackend, resolveTargetDefinition, validateBenchName } from "./config.ts";
import type { HarnessTarget } from "./types.ts";

export type InitCodexTargetOptions = {
  harness?: string;
  model: string;
  reasoningEffort?: string;
  auth?: string;
  credentialsStore?: string;
  codexHome?: string;
  provider?: string;
};
export type InitCodexTargetResult = { target: HarnessTarget; file: string };
export type InitHarnessTargetOptions = InitCodexTargetOptions & { claudeConfigDir?: string; apiKeyEnv?: string };
export type InitHarnessTargetResult = InitCodexTargetResult;

function assertDestination(root: string, name: string): string {
  const directory = path.join(root, "targets");
  try {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink()) throw new Error("targets 目录不允许符号链接");
    if (!entry.isDirectory()) throw new Error("targets 必须是目录");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const file = path.join(directory, `${name}.json`);
  try {
    lstatSync(file);
    throw new Error(`拒绝覆盖已有 target：targets/${name}.json`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return file;
}

/** Create a Codex target only after fully resolving its definition; no credential access or execution. */
export function initCodexTarget(root: string, name: string, options: InitCodexTargetOptions): InitCodexTargetResult {
  return initTarget(root, name, options, true);
}

/** Create a supported harness target without reading credentials or launching a harness. */
export function initHarnessTarget(root: string, name: string, options: InitHarnessTargetOptions): InitHarnessTargetResult {
  return initTarget(root, name, options, false);
}

function initTarget(root: string, name: string, options: InitHarnessTargetOptions, codexOnly: boolean): InitHarnessTargetResult {
  validateBenchName(name);
  const absoluteRoot = realpathSync(root);
  const harness = validateBenchName(options.harness ?? "codex-write");
  const profile = loadHarness(absoluteRoot, harness);
  if (codexOnly && profile.adapter !== "codex") throw new Error("initCodexTarget 仅支持 codex harness");
  if (profile.adapter !== "codex" && profile.adapter !== "claude-code" && profile.adapter !== "cursor-agent") throw new Error("targets init 仅支持 codex、claude-code 或 cursor-agent harness");
  const rawBackend: Record<string, unknown> = { auth: options.auth ?? "chatgpt", model: options.model };
  if (rawBackend.auth === "api-key") {
    if (profile.adapter === "cursor-agent") throw new Error("Cursor API key 使用 --auth cursor-api-key；不绑定 LLM provider");
    rawBackend.protocol = profile.adapter === "codex" ? "responses" : "anthropic-messages";
  }
  for (const key of ["reasoningEffort", "credentialsStore", "codexHome", "claudeConfigDir", "provider", "apiKeyEnv"] as const) {
    if (options[key] !== undefined) rawBackend[key] = options[key];
  }
  const target: HarnessTarget = { name, kind: "harness", harness, backend: parseHarnessBackend(rawBackend) };
  // Applies the same adapter/protocol/provider validation as an existing target before writing anything.
  resolveTargetDefinition(absoluteRoot, target);
  const file = assertDestination(absoluteRoot, name);
  mkdirSync(path.dirname(file), { recursive: true });
  assertDestination(absoluteRoot, name);
  writeFileSync(file, `${JSON.stringify(target, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { target, file };
}
