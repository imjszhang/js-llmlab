import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { loadTarget, resolveTarget } from "../src/lib/bench/config.ts";
import { initCodexTarget } from "../src/lib/bench/target-authoring.ts";
import type { InitCodexTargetOptions } from "../src/lib/bench/target-authoring.ts";
import { makeCommandLab, writeJson, writeText } from "./helpers.ts";

function setup(t: TestContext): string {
  const { root } = makeCommandLab();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, "harnesses", "codex-write.json"), {
    name: "codex-write", adapter: "codex", executable: "codex", permission: "workspace-write",
  });
  writeJson(path.join(root, "harnesses", "codex.json"), {
    name: "codex", adapter: "codex", executable: "codex", permission: "read-only",
  });
  writeJson(path.join(root, "harnesses", "claude.json"), {
    name: "claude", adapter: "claude-code", executable: "claude", permission: "workspace-write",
  });
  writeJson(path.join(root, "providers", "native.json"), {
    name: "native", apiKeyEnv: "BENCH_TARGET_KEY", endpoints: { responses: "https://native.test/v1" },
  });
  return root;
}

test("targets init writes a usable subscription definition with an explicit model and minimal defaults", (t) => {
  const root = setup(t);
  const expected = { name: "codex-current", kind: "harness", harness: "codex-write", backend: { auth: "chatgpt", model: "chosen-model" } };
  const result = initCodexTarget(root, "codex-current", { model: "chosen-model" });
  assert.equal(result.file, path.join(realpathSync(root), "targets", "codex-current.json"));
  assert.deepEqual(result.target, expected);
  assert.deepEqual(JSON.parse(readFileSync(result.file, "utf8")), expected);
  assert.deepEqual(loadTarget(root, "codex-current"), expected);
  const resolved = resolveTarget(root, "codex-current");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.equal(resolved.backend.credentialsStore, "auto");
  assert.equal(resolved.profile.permission, "workspace-write");
  assert.equal(existsSync(path.join(root, "data", "benchmarks")), false);
});

test("targets init retains model, effort, selected profile and login options without reading the login path", (t) => {
  const root = setup(t);
  const result = initCodexTarget(root, "codex-custom", {
    harness: "codex", auth: "chatgpt", model: "another-model", reasoningEffort: "xhigh",
    credentialsStore: "file", codexHome: "nonexistent-auth-source",
  });
  assert.deepEqual(result.target, {
    name: "codex-custom", kind: "harness", harness: "codex",
    backend: { auth: "chatgpt", model: "another-model", reasoningEffort: "xhigh", credentialsStore: "file", codexHome: "nonexistent-auth-source" },
  });
  assert.equal(existsSync(path.join(root, "nonexistent-auth-source")), false);
  const resolved = resolveTarget(root, "codex-custom");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.equal(resolved.profile.permission, "read-only");
  assert.equal(resolved.backend.codexHome, path.join(root, "nonexistent-auth-source"));
});

test("targets init can create an independent API provider backend with explicit responses routing", (t) => {
  const root = setup(t);
  const result = initCodexTarget(root, "codex-api", { auth: "api-key", provider: "native", model: "api-model", reasoningEffort: "low" });
  assert.deepEqual(result.target.backend, {
    auth: "api-key", provider: "native", model: "api-model", protocol: "responses", reasoningEffort: "low",
  });
  const resolved = resolveTarget(root, "codex-api");
  if (resolved.kind !== "harness") throw new Error("expected harness target");
  assert.equal(resolved.backend.apiKeyEnv, "BENCH_TARGET_KEY");
  assert.equal(resolved.backend.baseURL, "https://native.test/v1");
  assert.equal(readFileSync(result.file, "utf8").includes("BENCH_TARGET_KEY"), false);
});

test("invalid target initialization fails before creating a target file or targets directory", (t) => {
  const root = setup(t);
  const invalid: InitCodexTargetOptions[] = [
    { model: "" }, { model: "line\nmodel" }, { model: "a", harness: "../codex" },
    { model: "a", harness: "missing" }, { model: "a", harness: "claude" },
    { model: "a", auth: "subscription" }, { model: "a", reasoningEffort: "automatic" },
    { model: "a", credentialsStore: "environment" }, { model: "a", codexHome: "" },
    { model: "a", provider: "native" }, { model: "a", auth: "api-key" },
    { model: "a", auth: "api-key", provider: "missing" },
    { model: "a", auth: "api-key", provider: "native", codexHome: "auth" },
    { model: "a", auth: "api-key", provider: "native", credentialsStore: "auto" },
  ];
  for (const options of invalid) {
    assert.throws(() => initCodexTarget(root, "invalid", options));
    assert.equal(existsSync(path.join(root, "targets")), false);
  }
  for (const name of ["../outside", "a/b", "/absolute", "..", "a..b"]) {
    assert.throws(() => initCodexTarget(root, name, { model: "a" }), /名称/u);
  }
  writeJson(path.join(root, "providers", "native.json"), { name: "native", apiKeyEnv: "BENCH_TARGET_KEY", baseURL: "https://native.test" });
  assert.throws(() => initCodexTarget(root, "missing-endpoint", { auth: "api-key", provider: "native", model: "a" }), /未显式声明 endpoints/u);
  assert.equal(existsSync(path.join(root, "targets")), false);
});

test("targets init refuses existing files, directories and symlinks without overwriting them", (t) => {
  const root = setup(t);
  const first = initCodexTarget(root, "existing", { model: "first-model" });
  const initial = readFileSync(first.file, "utf8");
  assert.throws(() => initCodexTarget(root, "existing", { model: "second-model" }), /拒绝覆盖/u);
  assert.equal(readFileSync(first.file, "utf8"), initial);
  mkdirSync(path.join(root, "targets", "directory.json"));
  assert.throws(() => initCodexTarget(root, "directory", { model: "a" }), /拒绝覆盖/u);
  symlinkSync(path.join(root, "absent.json"), path.join(root, "targets", "dangling.json"));
  assert.throws(() => initCodexTarget(root, "dangling", { model: "a" }), /拒绝覆盖/u);
  assert.equal(existsSync(path.join(root, "absent.json")), false);
});

test("targets init refuses a symlinked or non-directory target parent", (t) => {
  const root = setup(t);
  mkdirSync(path.join(root, "other"));
  symlinkSync(path.join(root, "other"), path.join(root, "targets"));
  assert.throws(() => initCodexTarget(root, "escaped", { model: "a" }), /不允许符号链接/u);
  assert.equal(existsSync(path.join(root, "other", "escaped.json")), false);
  rmSync(path.join(root, "targets"));
  writeText(path.join(root, "targets"), "existing-file");
  assert.throws(() => initCodexTarget(root, "blocked", { model: "a" }), /必须是目录/u);
  assert.equal(readFileSync(path.join(root, "targets"), "utf8"), "existing-file");
});
