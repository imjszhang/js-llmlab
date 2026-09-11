import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import { runOnce } from "../src/commands/run.ts";
import { buildChatRequest } from "../src/lib/client.ts";
import type { ConfigSnapshot } from "../src/types.ts";
import { throwingCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

type DryRunOutput = {
  dryRun: boolean;
  variants: Array<{
    ref: string;
    config: ConfigSnapshot;
    apiKeyEnv: string;
    apiKeyPresent: boolean;
    messages: Array<{ role: string; content: string }>;
    request: Record<string, unknown>;
  }>;
};

function parseOutput(lines: string[]): DryRunOutput {
  assert.equal(lines.length, 1, "dry-run 只应输出一段 JSON");
  return JSON.parse(lines[0] ?? "") as DryRunOutput;
}

function noDataDirs(root: string): void {
  assert.equal(existsSync(path.join(root, "data", "sessions")), false);
  assert.equal(existsSync(path.join(root, "data", "comparisons")), false);
}

test("run --dry-run：thinking 与 reasoning_effort 进请求体，不发请求、不落盘", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "configs", "c.json"), {
    name: "c",
    provider: "test",
    model: "model-c",
    thinking: "enabled",
    reasoningEffort: "high",
  });
  const lines: string[] = [];

  await withEnvAsync(env, () =>
    runOnce(
      { config: "c", message: "x", dryRun: true },
      { root, complete: throwingCompleter(), log: (line) => lines.push(line) },
    ),
  );

  const out = parseOutput(lines);
  assert.equal(out.dryRun, true);
  assert.equal(out.variants.length, 1);
  const variant = out.variants[0];
  assert.ok(variant);
  assert.deepEqual(variant.request.thinking, { type: "enabled" });
  assert.equal(variant.request.reasoning_effort, "high");
  assert.equal(variant.request.model, "model-c");
  assert.equal(variant.apiKeyEnv, "TEST_KEY");
  assert.equal(variant.apiKeyPresent, true);
  assert.equal(variant.messages.at(-1)?.content, "x");
  assert.equal("apiKey" in variant.config, false);
  assert.doesNotMatch(lines[0] ?? "", /sk-test-abc/);
  noDataDirs(root);
});

test("compare --dry-run：每路一条，不需要 key", async () => {
  const { root, env } = makeCommandLab();
  const lines: string[] = [];

  await withEnvAsync({ ...env, TEST_KEY: undefined }, () =>
    runCompare(
      { configs: "a,b", message: "同一道题", dryRun: true },
      { root, complete: throwingCompleter(), log: (line) => lines.push(line) },
    ),
  );

  const out = parseOutput(lines);
  assert.deepEqual(
    out.variants.map((v) => v.ref),
    ["a", "b"],
  );
  assert.equal(out.variants[0]?.apiKeyPresent, false);
  assert.equal(out.variants[0]?.request.model, "model-a");
  assert.equal(out.variants[1]?.request.model, "model-b");
  assert.equal("thinking" in (out.variants[0]?.request ?? {}), false);
  noDataDirs(root);
});

test("buildChatRequest：可选字段缺省不出现，流式带 include_usage", () => {
  const base: ConfigSnapshot = {
    name: "x",
    provider: null,
    baseURL: "https://example.test/v1",
    model: "m",
    temperature: 0.5,
    maxTokens: 128,
    thinking: null,
    reasoningEffort: null,
    timeoutMs: 600000,
    maxRetries: 2,
  };
  const messages = [{ role: "user" as const, content: "hi" }];

  const plain = buildChatRequest(base, messages, false);
  assert.equal("thinking" in plain, false);
  assert.equal("reasoning_effort" in plain, false);
  assert.equal("stream" in plain, false);
  assert.equal(plain.model, "m");
  assert.equal(plain.max_tokens, 128);

  const reasoning = buildChatRequest(
    { ...base, thinking: "disabled", reasoningEffort: "max" },
    messages,
    true,
  );
  assert.deepEqual(reasoning.thinking, { type: "disabled" });
  assert.equal(reasoning.reasoning_effort, "max");
  assert.equal(reasoning.stream, true);
  assert.deepEqual(reasoning.stream_options, { include_usage: true });
});
