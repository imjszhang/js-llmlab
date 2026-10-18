import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { isCodexSubscriptionBackend, targetApiKeyEnv, targetProviderLabel } from "../src/lib/bench/backend.ts";
import { loadTarget, resolveTarget } from "../src/lib/bench/config.ts";
import { makeCommandLab, writeJson } from "./helpers.ts";

function setup(t: TestContext): string {
  const { root } = makeCommandLab();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const adapter of ["codex", "claude-code", "deepseek-harness", "opencode"]) {
    writeJson(path.join(root, "harnesses", `${adapter}.json`), {
      name: adapter, adapter, executable: adapter, permission: "workspace-write",
    });
  }
  writeJson(path.join(root, "providers", "native.json"), {
    name: "native", apiKeyEnv: "BENCH_CODEX_KEY", endpoints: { responses: "https://native.test/v1" },
  });
  return root;
}

function target(root: string, backend: unknown, harness = "codex"): void {
  writeJson(path.join(root, "targets", "cx.json"), { name: "cx", kind: "harness", harness, backend });
}

test("Codex subscription resolves explicit model and login path without reading credentials or providers", (t) => {
  const root = setup(t);
  const backend = {
    auth: "chatgpt", model: "selected-model", reasoningEffort: "high", credentialsStore: "keyring",
    codexHome: "missing-login-home",
  };
  target(root, backend);
  rmSync(path.join(root, "providers"), { recursive: true });
  const definition = loadTarget(root, "cx");
  assert.deepEqual(definition, { name: "cx", kind: "harness", harness: "codex", backend });
  const resolved = resolveTarget(root, "cx");
  assert.equal(resolved.kind, "harness");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.deepEqual(resolved.backend, { ...backend, codexHome: path.join(root, "missing-login-home") });
  assert.ok(isCodexSubscriptionBackend(resolved.backend));
  assert.equal(targetApiKeyEnv(resolved), undefined);
  assert.equal(targetProviderLabel(resolved), "chatgpt-subscription");
  assert.equal(existsSync(path.join(root, "missing-login-home")), false);
  assert.equal(existsSync(path.join(root, "data", "benchmarks")), false);
});

test("Codex subscription resolves current home and auto credentials store without materializing defaults in the definition", (t) => {
  const root = setup(t);
  const backend = { auth: "chatgpt", model: "selected-model" };
  target(root, backend);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousHome = process.env.HOME;
  const resolved = resolveTarget(root, "cx");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.deepEqual(resolved.definition.backend, backend);
  assert.deepEqual(resolved.backend, {
    ...backend, credentialsStore: "auto",
    codexHome: process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(homedir(), ".codex"),
  });
  assert.equal(process.env.CODEX_HOME, previousCodexHome);
  assert.equal(process.env.HOME, previousHome);
});

test("legacy API backend definitions and snapshots retain their exact fields", (t) => {
  const root = setup(t);
  const backend = { provider: "native", model: "arbitrary-api-model", protocol: "responses" };
  target(root, backend);
  const definition = loadTarget(root, "cx");
  assert.deepEqual(definition, { name: "cx", kind: "harness", harness: "codex", backend });
  const resolved = resolveTarget(root, "cx");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.deepEqual(resolved.backend, { ...backend, baseURL: "https://native.test/v1", apiKeyEnv: "BENCH_CODEX_KEY" });
  assert.equal(isCodexSubscriptionBackend(resolved.backend), false);
  assert.equal(targetApiKeyEnv(resolved), "BENCH_CODEX_KEY");
  assert.equal(targetProviderLabel(resolved), "native");
  writeJson(path.join(root, "targets", "llm.json"), { name: "llm", kind: "llm", config: "a" });
  const llm = resolveTarget(root, "llm");
  assert.equal(targetApiKeyEnv(llm), "TEST_KEY");
  assert.equal(targetProviderLabel(llm), "test");
});

test("Codex API targets retain explicit auth and reasoning effort independently of model choice", (t) => {
  const root = setup(t);
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
    const backend = { auth: "api-key", provider: "native", model: "selected-api-model", protocol: "responses", reasoningEffort: effort };
    target(root, backend);
    const resolved = resolveTarget(root, "cx");
    if (resolved.kind !== "harness") throw new Error("expected harness target");
    assert.deepEqual(resolved.backend, { ...backend, baseURL: "https://native.test/v1", apiKeyEnv: "BENCH_CODEX_KEY" });
    target(root, { auth: "chatgpt", model: "selected-chatgpt-model", reasoningEffort: effort });
    const subscription = resolveTarget(root, "cx");
    if (subscription.kind !== "harness") throw new Error("expected harness target");
    assert.equal(subscription.backend.reasoningEffort, effort);
  }
});

test("subscription settings reject API mixing, absent models, invalid stores and invalid effort", (t) => {
  const root = setup(t);
  for (const key of ["provider", "protocol", "baseURL", "apiKeyEnv", "pricing", "apiKey", "token"]) {
    target(root, { auth: "chatgpt", model: "selected-model", [key]: "not-allowed" });
    assert.throws(() => loadTarget(root, "cx"), /不接受/u);
  }
  for (const model of [undefined, null, "", " ", "line\nmodel"]) {
    target(root, { auth: "chatgpt", model });
    assert.throws(() => loadTarget(root, "cx"), /backend.model/u);
  }
  for (const credentialsStore of [null, "env", 1, ""]) {
    target(root, { auth: "chatgpt", model: "selected-model", credentialsStore });
    assert.throws(() => loadTarget(root, "cx"), /credentialsStore/u);
  }
  for (const auth of [null, "subscription", "api", 1]) {
    target(root, { auth, model: "selected-model" });
    assert.throws(() => loadTarget(root, "cx"), /backend.auth/u);
  }
  for (const reasoningEffort of [null, "automatic", "HIGH", "", 1]) {
    target(root, { auth: "chatgpt", model: "selected-model", reasoningEffort });
    assert.throws(() => loadTarget(root, "cx"), /reasoningEffort/u);
  }
  for (const codexHome of [null, "", " ", "line\nhome", "\u0000"]) {
    target(root, { auth: "chatgpt", model: "selected-model", codexHome });
    assert.throws(() => loadTarget(root, "cx"), /codexHome/u);
  }
});

test("subscription auth and Codex effort cannot silently apply to other harnesses", (t) => {
  const root = setup(t);
  for (const harness of ["claude-code", "deepseek-harness", "opencode"]) {
    target(root, { auth: "chatgpt", model: "selected-model" }, harness);
    assert.throws(() => resolveTarget(root, "cx"), /仅支持 codex harness/u);
    target(root, { provider: "native", model: "selected-model", protocol: "responses", reasoningEffort: "high" }, harness);
    assert.throws(() => resolveTarget(root, "cx"), /reasoningEffort 仅支持 codex harness/u);
  }
  for (const subscriptionField of ["codexHome", "credentialsStore"]) {
    target(root, { provider: "native", model: "selected-model", protocol: "responses", [subscriptionField]: "some-value" });
    assert.throws(() => loadTarget(root, "cx"), /不接受订阅字段/u);
  }
});
