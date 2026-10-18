import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listHarnesses, listTargets, listTasks, loadHarness, loadTarget, loadTask, resolveTarget } from "../src/lib/bench/config.ts";
import type { HarnessAdapter, HarnessProtocol } from "../src/lib/bench/types.ts";
import { parseNamedConfig } from "../src/lib/config.ts";
import { makeCommandLab, writeJson, writeText } from "./helpers.ts";

function setup() {
  const { root } = makeCommandLab();
  writeJson(path.join(root, "harnesses", "cc.json"), { name: "cc", adapter: "claude-code", executable: "claude", permission: "workspace-write" });
  writeJson(path.join(root, "harnesses", "cx.json"), { name: "cx", adapter: "codex", executable: "codex", permission: "read-only" });
  writeJson(path.join(root, "harnesses", "dsh.json"), { name: "dsh", adapter: "deepseek-harness", executable: "dsh", permission: "workspace-write" });
  writeJson(path.join(root, "harnesses", "oc.json"), { name: "oc", adapter: "opencode", executable: "opencode", permission: "read-only" });
  writeJson(path.join(root, "providers", "native.json"), {
    name: "native", apiKeyEnv: "BENCH_MISSING_KEY", endpoints: { "anthropic-messages": "https://native.test/anthropic", responses: "https://native.test/v1", "chat-completions": "https://native.test/chat/v1" },
  });
  writeJson(path.join(root, "targets", "llm.json"), { name: "llm", kind: "llm", config: "a" });
  writeJson(path.join(root, "targets", "cc.json"), { name: "cc", kind: "harness", harness: "cc", backend: { provider: "native", model: "model-a", protocol: "anthropic-messages" } });
  writeJson(path.join(root, "targets", "cx.json"), { name: "cx", kind: "harness", harness: "cx", backend: { provider: "native", model: "model-a", protocol: "responses" } });
  writeJson(path.join(root, "targets", "dsh.json"), { name: "dsh", kind: "harness", harness: "dsh", backend: { provider: "native", model: "model-a", protocol: "anthropic-messages" } });
  writeJson(path.join(root, "targets", "oc.json"), { name: "oc", kind: "harness", harness: "oc", backend: { provider: "native", model: "model-a", protocol: "chat-completions" } });
  return root;
}

test("bench resolves targets independently from model provider and without credentials", () => {
  const root = setup();
  assert.deepEqual(listTargets(root), ["cc", "cx", "dsh", "llm", "oc"]);
  assert.deepEqual(listHarnesses(root), ["cc", "cx", "dsh", "oc"]);
  assert.equal(loadHarness(root, "cc").permission, "workspace-write");
  const llm = resolveTarget(root, "llm");
  assert.equal(llm.kind, "llm");
  if (llm.kind !== "llm") throw new Error("expected llm");
  assert.equal(llm.config.model, "model-a");
  assert.equal(llm.systemText, "你是测试助手。");
  assert.equal("apiKey" in llm, false);
  for (const name of ["cc", "cx", "dsh", "oc"]) {
    const target = resolveTarget(root, name);
    if (target.kind !== "harness") throw new Error("expected harness");
    assert.equal(target.backend.provider, "native");
    assert.equal(target.backend.apiKeyEnv, "BENCH_MISSING_KEY");
    assert.equal("apiKey" in target.backend, false);
  }
});

test("bench requires explicit compatible protocol endpoints, with no vendor inference", () => {
  const root = setup();
  writeJson(path.join(root, "targets", "bad.json"), { name: "bad", kind: "harness", harness: "cc", backend: { provider: "native", model: "a", protocol: "responses" } });
  assert.throws(() => resolveTarget(root, "bad"), /需要 anthropic-messages/u);
  writeJson(path.join(root, "providers", "native.json"), { name: "native", baseURL: "https://native.test", apiKeyEnv: "KEY" });
  assert.throws(() => resolveTarget(root, "cc"), /未显式声明/u);
  for (const adapter of ["future-harness", "constructor", "__proto__"]) {
    writeJson(path.join(root, "harnesses", "future.json"), { name: "future", adapter, executable: "future", permission: "read-only" });
    assert.throws(() => loadHarness(root, "future"), /adapter/u);
  }
});

test("every provider-backed harness uses its declared protocol independently of provider branding", () => {
  const root = setup();
  const required: Record<Exclude<HarnessAdapter, "cursor-agent">, HarnessProtocol> = {
    "claude-code": "anthropic-messages", codex: "responses",
    "deepseek-harness": "anthropic-messages", opencode: "chat-completions",
  };
  const protocols: HarnessProtocol[] = ["anthropic-messages", "responses", "chat-completions"];
  for (const adapter of Object.keys(required) as Array<keyof typeof required>) {
    writeJson(path.join(root, "harnesses", "test.json"), { name: "test", adapter, executable: "/custom/harness", permission: "read-only" });
    for (const protocol of protocols) {
      writeJson(path.join(root, "targets", "test.json"), {
        name: "test", kind: "harness", harness: "test",
        backend: { provider: "native", model: "arbitrary-model", protocol },
      });
      if (protocol !== required[adapter]) {
        assert.throws(() => resolveTarget(root, "test"), /需要.*协议/u);
        continue;
      }
      const target = resolveTarget(root, "test");
      if (target.kind !== "harness") throw new Error("expected harness");
      assert.equal(target.profile.executable, "/custom/harness");
      assert.equal(target.backend.model, "arbitrary-model");
      assert.equal(target.backend.protocol, protocol);
      assert.equal(target.backend.baseURL, protocol === "anthropic-messages"
        ? "https://native.test/anthropic" : protocol === "responses"
          ? "https://native.test/v1" : "https://native.test/chat/v1");
    }
  }
});

test("new harnesses cannot derive missing endpoints from a provider name or base URL", () => {
  const root = setup();
  for (const [harness, protocol] of [["dsh", "anthropic-messages"], ["oc", "chat-completions"]] as const) {
    writeJson(path.join(root, "providers", "deepseek.json"), {
      name: "deepseek", apiKeyEnv: "BENCH_MISSING_KEY", baseURL: "https://api.deepseek.com",
      endpoints: { responses: "https://api.deepseek.com/v1" },
    });
    writeJson(path.join(root, "targets", "missing.json"), {
      name: "missing", kind: "harness", harness,
      backend: { provider: "deepseek", model: "deepseek-flash", protocol },
    });
    assert.throws(() => resolveTarget(root, "missing"), /未显式声明 endpoints/u);
  }
});

test("bench tasks resolve prompt and fixture snapshots with check defaults", () => {
  const root = setup();
  writeText(path.join(root, "tasks", "prompts", "fix.md"), "Fix parser\n");
  writeText(path.join(root, "tasks", "fixtures", "parser", "index.js"), "broken\n");
  writeJson(path.join(root, "tasks", "fix.json"), {
    name: "fix", promptFile: "tasks/prompts/fix.md", fixture: "tasks/fixtures/parser",
    checks: [{ kind: "command", argv: ["node", "--test"] }, { kind: "file-exists", path: "index.js" }, { kind: "file-contains", path: "index.js", text: "fixed" }, { kind: "output-contains", text: "done" }],
  });
  assert.deepEqual(listTasks(root), ["fix"]);
  assert.deepEqual(loadTask(root, "fix"), {
    name: "fix", prompt: "Fix parser\n", fixture: "tasks/fixtures/parser", timeoutMs: 120_000,
    checks: [{ kind: "command", argv: ["node", "--test"], timeoutMs: 10_000 }, { kind: "file-exists", path: "index.js" }, { kind: "file-contains", path: "index.js", text: "fixed" }, { kind: "output-contains", text: "done" }],
  });
});

test("bench rejects unsafe names, escapes, symlinks and malformed task definitions", () => {
  const root = setup();
  for (const name of ["../cc", "a/b", "..", "/tmp/a", "a..b"]) assert.throws(() => loadTarget(root, name), /名称/u);
  for (const data of [
    { prompt: "x", promptFile: "x.md" },
    {},
    { prompt: "x", timeoutMs: 0 },
    { prompt: "x", checks: [{ kind: "file-exists", path: "../source" }] },
    { prompt: "x", fixture: "." },
    { promptFile: ".env" },
    { promptFile: "archives/old.md" },
    { prompt: "x", promptFile: "/outside" },
    { prompt: "x", checks: [{ kind: "command", argv: [] }] },
    { prompt: "x", checks: [{ kind: "command", argv: ["node"], timeoutMs: 1.5 }] },
  ]) {
    writeJson(path.join(root, "tasks", "bad.json"), { name: "bad", ...data });
    assert.throws(() => loadTask(root, "bad"));
  }
  writeText(path.join(root, "real.txt"), "secret");
  symlinkSync(path.join(root, "real.txt"), path.join(root, "tasks", "linked.md"));
  writeJson(path.join(root, "tasks", "bad.json"), { name: "bad", promptFile: "tasks/linked.md" });
  assert.throws(() => loadTask(root, "bad"), /符号链接/u);
  writeJson(path.join(root, "targets", "mismatch.json"), { name: "other", kind: "llm", config: "a" });
  assert.throws(() => loadTarget(root, "mismatch"), /文件名一致/u);
});

test("provider endpoints are explicit HTTP protocol bases and cannot embed secrets", () => {
  const endpoints = { responses: "https://demo.test/v1", "anthropic-messages": "http://localhost:8080" };
  assert.deepEqual(parseNamedConfig({ endpoints }).endpoints, endpoints);
  for (const endpoints of [[], { responses: "file:///tmp/x" }, { responses: "https://user:secret@example.test" }, { unknown: "https://example.test" }, { responses: 1 }]) {
    assert.throws(() => parseNamedConfig({ endpoints }));
  }
});
