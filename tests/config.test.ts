import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  collectConfigRefs,
  listConfigs,
  parseNameList,
  peekConfig,
  peekConfigRef,
  resolveConfig,
  safeVariantName,
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
      JS_LLMLAB_PROVIDER: undefined,
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
      JS_LLMLAB_PROVIDER: undefined,
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
      JS_LLMLAB_PROVIDER: undefined,
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
        "provider",
        "reasoningEffort",
        "temperature",
        "thinking",
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

test("没有配置文件时，把名称当作模型 id，继承 env provider", () => {
  const root = makeLabRoot();
  withEnv(
    {
      JS_LLMLAB_PROVIDER: undefined,
      OPENAI_API_KEY: "sk-test-key-1234",
      OPENAI_BASE_URL: "https://proxy.example.test/v1",
      OPENAI_MODEL: "deepseek-chat",
    },
    () => {
      const peeked = peekConfigRef(root, "gpt-4o");
      assert.equal(peeked.source, "model");
      assert.equal(peeked.snapshot.name, "gpt-4o");
      assert.equal(peeked.snapshot.model, "gpt-4o");
      assert.equal(peeked.snapshot.baseURL, "https://proxy.example.test/v1");
      assert.equal("apiKey" in peeked.snapshot, false);

      const named = peekConfigRef(root, "missing-file-but-wait");
      writeJson(path.join(root, "configs", "gpt-4o.json"), {
        name: "gpt-4o",
        model: "gpt-4o",
        temperature: 0.2,
      });
      const file = peekConfigRef(root, "gpt-4o");
      assert.equal(file.source, "file");
      assert.equal(file.snapshot.temperature, 0.2);
      assert.equal(named.source, "model");
    },
  );
});

test("collectConfigRefs 合并 --configs 与 --models 并去重", () => {
  assert.deepEqual(parseNameList(" a, b , ,c "), ["a", "b", "c"]);
  assert.deepEqual(
    collectConfigRefs({ configs: "deepseek,gpt-4o", models: "gpt-4o,kimi-k2.5" }),
    ["deepseek", "gpt-4o", "kimi-k2.5"],
  );
  assert.equal(safeVariantName("claude/sonnet"), "claude_sonnet");
});

test("env < provider < 命名配置 < CLI", () => {
  const root = makeLabRoot();
  writeJson(path.join(root, "providers", "llmcore.json"), {
    name: "llmcore",
    baseURL: "https://proxy.llm-core.cn/v1",
    apiKeyEnv: "LLMCORE_API_KEY",
    model: "deepseek-chat",
    temperature: 0.3,
  });
  writeJson(path.join(root, "configs", "ds-v4-pro.json"), {
    name: "ds-v4-pro",
    provider: "llmcore",
    model: "deepseek-v4-pro",
  });
  writeJson(path.join(root, "suites", "deepseek.json"), {
    configs: ["ds-chat", "ds-v4-flash", "ds-v4-pro"],
  });

  withEnv(
    {
      JS_LLMLAB_PROVIDER: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_MODEL: undefined,
      LLMCORE_API_KEY: "sk-llmcore-test",
    },
    () => {
      const provider = peekConfig(root, undefined, { provider: "llmcore" });
      assert.equal(provider.snapshot.provider, "llmcore");
      assert.equal(provider.snapshot.baseURL, "https://proxy.llm-core.cn/v1");
      assert.equal(provider.snapshot.model, "deepseek-chat");
      assert.equal(provider.apiKeyEnv, "LLMCORE_API_KEY");
      assert.equal(provider.apiKeyPresent, true);

      writeJson(path.join(root, "configs", "ds-v4-flash-reason.json"), {
        name: "ds-v4-flash-reason",
        provider: "llmcore",
        model: "deepseek-v4-flash",
        thinking: "enabled",
        reasoningEffort: "high",
      });
      const named = peekConfigRef(root, "ds-v4-pro");
      assert.equal(named.source, "file");
      assert.equal(named.snapshot.provider, "llmcore");
      assert.equal(named.snapshot.model, "deepseek-v4-pro");
      assert.equal(named.snapshot.baseURL, "https://proxy.llm-core.cn/v1");
      const reason = peekConfigRef(root, "ds-v4-flash-reason");
      assert.equal(reason.snapshot.thinking, "enabled");
      assert.equal(reason.snapshot.reasoningEffort, "high");

      const modelRef = peekConfigRef(root, "deepseek-v4-flash", { provider: "llmcore" });
      assert.equal(modelRef.source, "model");
      assert.equal(modelRef.snapshot.model, "deepseek-v4-flash");
      assert.equal(modelRef.snapshot.provider, "llmcore");

      assert.deepEqual(collectConfigRefs({ suite: "deepseek" }, root), [
        "ds-chat",
        "ds-v4-flash",
        "ds-v4-pro",
      ]);
    },
  );
});
