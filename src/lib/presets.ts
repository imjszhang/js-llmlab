import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { getPromptsDir } from "./paths.ts";

export type PresetKind = "system" | "user";
export type UserPresetMode = "run" | "chat";

export function listPresets(root: string, kind: PresetKind): string[] {
  const dir = path.join(getPromptsDir(root), kind);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") || file.endsWith(".txt"))
    .map((file) => file.replace(/\.(md|txt)$/u, ""))
    .sort();
}

export function loadPreset(root: string, kind: PresetKind, name: string): string {
  const dir = path.join(getPromptsDir(root), kind);
  const mdPath = path.join(dir, `${name}.md`);
  const txtPath = path.join(dir, `${name}.txt`);
  const filePath = existsSync(mdPath) ? mdPath : existsSync(txtPath) ? txtPath : null;
  if (filePath === null) {
    throw new Error(`找不到${kind}预设：${name}（期望 ${mdPath}）`);
  }
  return readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trimEnd();
}

export function applyUserPreset(
  template: string,
  input: string,
  mode: UserPresetMode,
): string {
  if (template.includes("{{input}}")) {
    return template.replaceAll("{{input}}", input);
  }
  if (mode === "run") {
    return template;
  }
  if (input.trim() === "") {
    return template;
  }
  return `${template}\n\n${input}`;
}

export function resolveSystemText(root: string, name: string | null): string {
  if (name === null || name === "") {
    return "";
  }
  return loadPreset(root, "system", name);
}

export function resolveUserText(params: {
  root: string;
  userPreset: string | null;
  input: string;
  mode: UserPresetMode;
}): string {
  const { root, userPreset, input, mode } = params;
  if (userPreset === null || userPreset === "") {
    if (input.trim() === "") {
      throw new Error("需要 --message、--input，或带内容的 user 预设");
    }
    return input;
  }
  const template = loadPreset(root, "user", userPreset);
  if (template.includes("{{input}}") && input.trim() === "") {
    throw new Error(`user 预设 ${userPreset} 含 {{input}}，请提供 --message 或 --input`);
  }
  return applyUserPreset(template, input, mode);
}

export function readMessageInput(message?: string, inputFile?: string): string {
  if (message !== undefined && inputFile !== undefined) {
    throw new Error("不要同时使用 --message 和 --input");
  }
  if (inputFile !== undefined) {
    const resolved = path.resolve(inputFile);
    if (!existsSync(resolved)) {
      throw new Error(`找不到输入文件：${resolved}`);
    }
    return readFileSync(resolved, "utf8").replace(/^\uFEFF/u, "");
  }
  return message ?? "";
}
