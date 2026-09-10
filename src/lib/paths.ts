import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PACKAGE_NAME = "js-llmlab";

export function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (
          typeof raw === "object" &&
          raw !== null &&
          "name" in raw &&
          (raw as { name?: unknown }).name === PACKAGE_NAME
        ) {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(startDir);
    }
    dir = parent;
  }
}

export function getDataDir(root: string): string {
  const override = process.env.JS_LLMLAB_DATA_DIR;
  if (override !== undefined && override !== "") {
    return path.resolve(override);
  }
  return path.join(root, "data");
}

export function getConfigsDir(root: string): string {
  return path.join(root, "configs");
}

export function getPromptsDir(root: string): string {
  return path.join(root, "prompts");
}

export function getSessionsDir(root: string): string {
  return path.join(getDataDir(root), "sessions");
}

export function getComparisonsDir(root: string): string {
  return path.join(getDataDir(root), "comparisons");
}

export function sessionDir(root: string, sessionId: string): string {
  return path.join(getSessionsDir(root), sessionId);
}

export function comparisonDir(root: string, comparisonId: string): string {
  return path.join(getComparisonsDir(root), comparisonId);
}
