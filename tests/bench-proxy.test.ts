import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTarget, executionSecrets } from "../src/lib/bench/executor.ts";
import { proxyEnvironment } from "../src/lib/bench/network-environment.ts";
import { runBenchmark } from "../src/lib/bench/runner.ts";
import type { HarnessAdapter, HarnessProtocol, ProcessRequest, ProcessResult, ResolvedHarnessTarget } from "../src/lib/bench/types.ts";
import { withEnvAsync } from "./helpers.ts";

const credentialedProxy = "http://proxy-user:proxy%2Fsecret@proxy.test:8080";
const proxies = {
  HTTPS_PROXY: credentialedProxy, HTTP_PROXY: "http://proxy.test:8081", ALL_PROXY: "socks5://proxy.test:1080", NO_PROXY: "localhost,.test",
  https_proxy: credentialedProxy, http_proxy: "http://proxy.test:8082", all_proxy: "socks5://proxy.test:1081", no_proxy: "localhost,.lower.test",
};
const sensitive = [credentialedProxy, "proxy-user", "proxy%2Fsecret", "proxy/secret", Buffer.from("proxy-user:proxy/secret").toString("base64")];

function target(adapter: HarnessAdapter): ResolvedHarnessTarget {
  const protocol: HarnessProtocol = adapter === "codex" ? "responses" : adapter === "opencode" ? "chat-completions" : "anthropic-messages";
  const backend = { provider: "test-provider", model: "test-model", protocol };
  return { name: `proxy-${adapter}`, kind: "harness",
    definition: { name: `proxy-${adapter}`, kind: "harness", harness: adapter, backend },
    profile: { name: adapter, adapter, executable: `/fake/${adapter}`, permission: "workspace-write" },
    backend: { ...backend, baseURL: "https://model.test/v1", apiKeyEnv: "PROXY_TEST_API_KEY" } };
}

function processResult(stdout: string, extras: Partial<ProcessResult> = {}): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1, ...extras };
}

async function fileContents(directory: string): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await fileContents(child));
    else contents.push(await readFile(child, "utf8"));
  }
  return contents;
}

test("proxy secrets include encoded and decoded credentials without treating NO_PROXY or ordinary addresses as secrets", async () => {
  await withEnvAsync(proxies, async () => {
    assert.deepEqual(proxyEnvironment(), proxies);
    const secrets = executionSecrets(undefined);
    for (const value of sensitive) assert.ok(secrets.includes(value), `Missing proxy secret form: ${value}`);
    assert.ok(!secrets.includes(proxies.NO_PROXY));
    assert.ok(!secrets.includes(proxies.HTTP_PROXY));
  });
});

test("each API harness receives proxy settings at probe and launch, and scrubs proxy credentials from failures", async (t) => {
  for (const adapter of ["claude-code", "codex", "deepseek-harness", "opencode"] as const) {
    await t.test(adapter, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "llmlab-proxy-executor-"));
      const workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const requests: ProcessRequest[] = [];
      try {
        await withEnvAsync({ ...proxies, PROXY_TEST_API_KEY: "selected-provider-key", UNRELATED_PROVIDER_TOKEN: "unrelated-provider-key" }, async () => {
          const result = await executeTarget({ root, target: target(adapter), workspace, home: path.join(root, "home"),
            task: { name: "proxy-task", prompt: "Do the task.", timeoutMs: 5000, checks: [] } }, { runProcess: async (request) => {
              requests.push(request);
              for (const [name, value] of Object.entries(proxies)) assert.equal(request.env?.[name], value);
              assert.equal(request.env?.UNRELATED_PROVIDER_TOKEN, undefined);
              if (request.args[0] === "--version") {
                assert.equal(request.env?.ANTHROPIC_API_KEY, undefined);
                assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
                return processResult(adapter === "opencode" ? "2.0.32" : "test-version");
              }
              return processResult(JSON.stringify({ type: "error", error: sensitive.join(" | ") }),
                { stderr: sensitive.join(" | "), error: sensitive.join(" | "), exitCode: 7 });
            } });
          assert.equal(requests.length, 2);
          assert.equal(result.status, "failed");
          const saved = JSON.stringify(result);
          for (const value of sensitive) assert.ok(!saved.includes(value));
          assert.match(saved, /"HTTPS_PROXY":"\*\*\*"/u);
          assert.match(saved, /"HTTP_PROXY":"http:\/\/proxy\.test:8081"/u);
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test("benchmark spec, raw plan, output, events and reports never persist proxy credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmlab-proxy-records-"));
  try {
    await withEnvAsync({ ...proxies, PROXY_TEST_API_KEY: "selected-provider-key" }, async () => {
      const result = await runBenchmark(root, { task: { name: "proxy-task", prompt: sensitive.join(" | "), timeoutMs: 5000, checks: [] },
        targets: [target("claude-code")], repeat: 1, concurrency: 1 }, { runProcess: async (request) => {
          if (request.args[0] === "--version") return processResult("test-version");
          return processResult(JSON.stringify({ type: "result", subtype: "success", session_id: "proxy-session", result: sensitive.join(" | ") }),
            { stderr: sensitive.join(" | ") });
        } });
      assert.equal(result.records[0]?.execution.status, "completed");
      const all = [...await fileContents(result.dir), JSON.stringify(result)].join("\n");
      for (const value of sensitive) assert.ok(!all.includes(value));
      assert.match(all, /\*\*\*/u);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
