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
  mkdirSync(path.join(root, "providers"), { recursive: true });
  mkdirSync(path.join(root, "suites"), { recursive: true });
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

function applyEnv(env: Record<string, string | undefined>): Map<string, string | undefined> {
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
  return previous;
}

function restoreEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = applyEnv(env);
  try {
    fn();
  } finally {
    restoreEnv(previous);
  }
}

export async function withEnvAsync<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = applyEnv(env);
  try {
    return await fn();
  } finally {
    restoreEnv(previous);
  }
}

/**
 * 一个带 provider、两套命名配置和 default system 预设的临时实验室，
 * 供命令层测试直接跑 run / compare。API key 走 `TEST_KEY`。
 */
export function makeCommandLab(): { root: string; env: Record<string, string | undefined> } {
  const root = makeLabRoot();
  writeJson(path.join(root, "providers", "test.json"), {
    name: "test",
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_KEY",
    model: "demo",
    temperature: 0.3,
    maxTokens: 64,
    // 假实验室缺省不重试，让 failTimes: 1 的用例保持确定性；重试用例自己开。
    maxRetries: 0,
  });
  writeJson(path.join(root, "configs", "a.json"), { name: "a", provider: "test", model: "model-a" });
  writeJson(path.join(root, "configs", "b.json"), { name: "b", provider: "test", model: "model-b" });
  writeText(path.join(root, "prompts", "system", "default.md"), "你是测试助手。\n");
  const env: Record<string, string | undefined> = {
    TEST_KEY: "sk-test-abc",
    JS_LLMLAB_PROVIDER: "test",
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_MODEL: undefined,
  };
  return { root, env };
}
