import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  listConfigs,
  peekConfig,
  resolveConfig,
  toSnapshot,
} from "../src/lib/config.ts";
import { makeLabRoot, withEnv, writeJson } from "./helpers.ts";

test("配置合并：env < 命名文件 < CLI", () => {
  const root = makeLabRoot();
  writeJson(path.join(root, "configs", "deepseek.json"), {
    name: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    temperature: 0.3,
    maxTokens: 4096,
  });

  withEnv(
    {
      OPENAI_API_KEY: "sk-test-key-1234",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_MODEL: "gpt-4o-mini",
      OPENAI_TEMPERATURE: "1",
      OPENAI_MAX_TOKENS: "1024",
    },
    () => {
      const envOnly = peekConfig(root);
      assert.equal(envOnly.snapshot.model, "gpt-4o-mini");
      assert.equal(envOnly.snapshot.baseURL, "https://api.openai.com/v1");

      const named = peekConfig(root, "deepseek");
      assert.equal(named.snapshot.name, "deepseek");
      assert.equal(named.snapshot.model, "deepseek-chat");
      assert.equal(named.snapshot.baseURL, "https://api.deepseek.com");
      assert.equal(named.snapshot.temperature, 0.3);
      assert.equal(named.snapshot.maxTokens, 4096);

      const overridden = peekConfig(root, "deepseek", { model: "deepseek-reasoner", temperature: 0 });
      assert.equal(overridden.snapshot.model, "deepseek-reasoner");
      assert.equal(overridden.snapshot.temperature, 0);
      assert.equal(overridden.snapshot.baseURL, "https://api.deepseek.com");
    },
  );
});

test("resolveConfig 需要 API Key，快照不含密钥", () => {
  const root = makeLabRoot();
  writeJson(path.join(root, "configs", "default.json"), { name: "default" });

  withEnv(
    {
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: "https://example.test",
      OPENAI_MODEL: "demo",
    },
    () => {
      const peeked = peekConfig(root, "default");
      assert.equal(peeked.apiKeyPresent, false);
      assert.throws(() => resolveConfig(root, "default"), /缺少 API Key/);
    },
  );

  withEnv(
    {
      OPENAI_API_KEY: "sk-secret-9999",
      OPENAI_BASE_URL: "https://example.test",
      OPENAI_MODEL: "demo",
    },
    () => {
      const resolved = resolveConfig(root, "default");
      assert.equal(resolved.apiKey, "sk-secret-9999");
      const snapshot = toSnapshot(resolved);
      assert.equal("apiKey" in snapshot, false);
      assert.deepEqual(Object.keys(snapshot).sort(), [
        "baseURL",
        "maxTokens",
        "model",
        "name",
        "temperature",
      ]);
    },
  );
});

test("listConfigs 读取 configs 目录", () => {
  const root = makeLabRoot();
  writeJson(path.join(root, "configs", "default.json"), { name: "default" });
  writeJson(path.join(root, "configs", "deepseek.json"), { name: "deepseek" });
  assert.deepEqual(listConfigs(root), ["deepseek", "default"]);
});
