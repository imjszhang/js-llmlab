import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function makeLabRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "js-llmlab-"));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "js-llmlab", private: true }, null, 2)}\n`,
  );
  mkdirSync(path.join(root, "configs"), { recursive: true });
  mkdirSync(path.join(root, "prompts", "system"), { recursive: true });
  mkdirSync(path.join(root, "prompts", "user"), { recursive: true });
  mkdirSync(path.join(root, "data"), { recursive: true });
  return root;
}

export function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
}

export function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
