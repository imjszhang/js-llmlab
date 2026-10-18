import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runBench } from "../src/commands/bench.ts";
import { readBenchmark } from "../src/lib/bench/store.ts";
import type { ProcessResult } from "../src/lib/bench/types.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

function result(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1 };
}

test("all new Pro and Flash targets dry-run without credentials, CLI processes or data writes", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "service.json"), { name: "service", apiKeyEnv: "TEST_KEY", endpoints: {
    "anthropic-messages": "https://service.test/anthropic", "chat-completions": "https://service.test/v1",
  } });
  const names: string[] = [];
  for (const adapter of ["deepseek-harness", "opencode"]) {
    writeJson(path.join(root, "harnesses", `${adapter}.json`), { name: adapter, adapter, executable: `missing-${adapter}`, permission: "workspace-write" });
    for (const model of ["pro", "flash"]) {
      const name = `${adapter}-${model}`;
      names.push(name);
      writeJson(path.join(root, "targets", `${name}.json`), { name, kind: "harness", harness: adapter,
        backend: { provider: "service", model, protocol: adapter === "opencode" ? "chat-completions" : "anthropic-messages" } });
    }
  }
  writeJson(path.join(root, "tasks", "hello.json"), { name: "hello", prompt: "Reply OK.", checks: [] });
  rmSync(path.join(root, "data"), { recursive: true, force: true });
  try {
    await withEnvAsync({ ...env, TEST_KEY: undefined }, async () => {
      const logs: string[] = [];
      const experiment = await runBench({ task: "hello", targets: names.join(","), dryRun: true }, {
        root, log: (text) => logs.push(text), runProcess: async () => { throw new Error("dry-run started a process"); },
      });
      assert.equal(experiment, null);
      const snapshot = JSON.parse(logs[0] ?? "{}");
      assert.equal(snapshot.targets.length, 4);
      for (const target of snapshot.targets) assert.equal(target.plan.process.env.JS_LLMLAB_HARNESS_API_KEY, undefined);
      assert.equal(existsSync(path.join(root, "data")), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DeepSeek Harness participates in the unified bench with a separately named provider, frozen plan and secret-free results", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "service.json"), { name: "service", apiKeyEnv: "TEST_KEY", endpoints: { "anthropic-messages": "https://service.test/anthropic" } });
  writeJson(path.join(root, "harnesses", "dsh.json"), { name: "dsh", adapter: "deepseek-harness", executable: "fake-dsh", permission: "workspace-write" });
  writeJson(path.join(root, "targets", "agent.json"), { name: "agent", kind: "harness", harness: "dsh", backend: { provider: "service", model: "service-model", protocol: "anthropic-messages" } });
  writeJson(path.join(root, "tasks", "hello.json"), { name: "hello", prompt: "Reply OK.", checks: [{ kind: "output-contains", text: "OK" }] });
  try {
    await withEnvAsync(env, async () => {
      let invocations = 0;
      const experiment = await runBench({ task: "hello", targets: "agent" }, {
        root, log: () => {}, error: () => {}, runProcess: async (request) => {
          invocations += 1;
          if (request.args[0] === "--version") {
            assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
            return result("dsh 0.2.0-rc.2");
          }
          assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, env.TEST_KEY);
          assert.equal(request.env?.DSH_TELEMETRY_DISABLED, "1");
          const patch = request.args[request.args.indexOf("--patch") + 1];
          assert.ok(patch);
          const config = readFileSync(patch, "utf8");
          assert.match(config, /https:\/\/service.test\/anthropic/u);
          assert.match(config, /service-model/u);
          assert.doesNotMatch(config, /sk-test-abc/u);
          return result([
            { type: "session", sessionId: "session-test", cwd: request.cwd },
            { type: "status", phase: "step_end", turn: 0, step: 0, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 3, totalTokens: 19 } },
            { type: "status", phase: "turn_end", reason: { kind: "completed" } },
            { type: "final", text: "OK sk-test-abc" },
          ].map((event) => JSON.stringify(event)).join("\n"));
        },
      });
      assert.ok(experiment);
      assert.equal(invocations, 2);
      assert.equal(experiment.failed, false);
      const record = readBenchmark(root, experiment.spec.id).records[0];
      assert.ok(record);
      assert.equal(record.execution.usage?.totalTokens, 19);
      assert.equal(record.execution.usage?.promptTokens, 17);
      assert.equal(record.execution.harnessVersion, "dsh 0.2.0-rc.2");
      assert.equal(record.execution.cost, null);
      assert.equal(record.execution.responseModel, null);
      assert.equal(record.grade.status, "passed");
      assert.equal(record.execution.text, "OK ***");
      assert.doesNotMatch(JSON.stringify(record), /sk-test-abc/u);
      assert.ok(existsSync(path.join(experiment.dir, "variants/agent/run-1/events.jsonl")));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode V2 runs through bench with independent chat backend, native events and unknown price", async () => {
  const { root, env } = makeCommandLab();
  writeJson(path.join(root, "providers", "service.json"), { name: "service", apiKeyEnv: "TEST_KEY", endpoints: { "chat-completions": "https://service.test/v1" } });
  writeJson(path.join(root, "harnesses", "oc.json"), { name: "oc", adapter: "opencode", executable: "fake-opencode", permission: "workspace-write" });
  writeJson(path.join(root, "targets", "agent.json"), { name: "agent", kind: "harness", harness: "oc", backend: { provider: "service", model: "service-model", protocol: "chat-completions" } });
  writeJson(path.join(root, "tasks", "hello.json"), { name: "hello", prompt: "Reply OK.", checks: [{ kind: "output-contains", text: "OK" }] });
  try {
    await withEnvAsync(env, async () => {
      let invocations = 0;
      const experiment = await runBench({ task: "hello", targets: "agent" }, {
        root, log: () => {}, error: () => {}, runProcess: async (request) => {
          invocations += 1;
          if (request.args[0] === "--version") {
            assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
            return result("opencode v2.0.32\n");
          }
          if (request.args[0] === "session") {
            assert.ok(request.args.includes("export"));
            assert.ok(request.args.includes("ses_test"));
            assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, undefined);
            return result(JSON.stringify({
              info: { id: "ses_test", model: { id: "service-model", providerID: "js_llmlab" },
                outcome: "succeeded", time: { idle: 3 }, location: { directory: request.cwd },
                tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } } },
              messages: [
                { id: "user", type: "user", text: "Reply OK." },
                { id: "msg", type: "assistant", model: { id: "service-model", providerID: "js_llmlab" }, finish: "stop", time: { completed: 2 }, content: [{ type: "text", text: "OK sk-test-abc" }] },
                { id: "idle", type: "idle", outcome: "succeeded" },
              ],
            }));
          }
          assert.equal(request.env?.JS_LLMLAB_HARNESS_API_KEY, env.TEST_KEY);
          assert.ok(request.args.includes("--standalone"));
          assert.equal(request.terminationGraceMs, 4000);
          const configDir = request.env?.OPENCODE_CONFIG_DIR;
          assert.ok(configDir);
          const config = readFileSync(path.join(configDir, "opencode.json"), "utf8");
          assert.match(config, /https:\/\/service.test\/v1/u);
          assert.match(config, /service-model/u);
          assert.doesNotMatch(config, /sk-test-abc/u);
          return result([
            { type: "step_start", sessionID: "ses_test", part: { id: "start", messageID: "msg" } },
            { type: "text", sessionID: "ses_test", part: { id: "text", messageID: "msg", text: "OK sk-test-abc" } },
            { type: "step_finish", sessionID: "ses_test", part: { id: "end", messageID: "msg", reason: "stop", cost: 0, tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } } } },
          ].map((event) => JSON.stringify(event)).join("\n"));
        },
      });
      assert.ok(experiment);
      assert.equal(invocations, 3);
      assert.equal(experiment.failed, false);
      const record = readBenchmark(root, experiment.spec.id).records[0];
      assert.ok(record);
      assert.equal(record.execution.harnessVersion, "opencode v2.0.32");
      assert.equal(record.execution.usage?.promptTokens, 15);
      assert.equal(record.execution.usage?.completionTokens, 5);
      assert.equal(record.execution.usage?.totalTokens, 20);
      assert.equal(record.execution.cost, null);
      assert.equal(record.execution.responseModel, null);
      assert.equal(record.grade.status, "passed");
      assert.equal(record.execution.text, "OK ***");
      assert.doesNotMatch(JSON.stringify(record), /sk-test-abc/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode V1 and unrecognized versions fail before config files or task launch", async () => {
  for (const version of ["1.19.3", "unrecognized version", "12.0.32"]) {
    const { root, env } = makeCommandLab();
    writeJson(path.join(root, "providers", "service.json"), { name: "service", apiKeyEnv: "TEST_KEY", endpoints: { "chat-completions": "https://service.test/v1" } });
    writeJson(path.join(root, "harnesses", "oc.json"), { name: "oc", adapter: "opencode", executable: "fake-opencode", permission: "workspace-write" });
    writeJson(path.join(root, "targets", "agent.json"), { name: "agent", kind: "harness", harness: "oc", backend: { provider: "service", model: "service-model", protocol: "chat-completions" } });
    writeJson(path.join(root, "tasks", "hello.json"), { name: "hello", prompt: "Reply OK.", checks: [] });
    try {
      await withEnvAsync(env, async () => {
        let invocations = 0;
        const experiment = await runBench({ task: "hello", targets: "agent" }, {
          root, log: () => {}, error: () => {}, runProcess: async (request) => {
            invocations += 1;
            assert.deepEqual(request.args, ["--version"]);
            assert.equal(existsSync(request.env?.OPENCODE_CONFIG_DIR ?? ""), false);
            return result(version);
          },
        });
        assert.ok(experiment);
        assert.equal(invocations, 1);
        assert.equal(experiment.failed, true);
        const record = readBenchmark(root, experiment.spec.id).records[0];
        assert.ok(record);
        assert.equal(record.execution.status, "failed");
        assert.match(record.execution.error ?? "", /requires @opencode\/cli V2/u);
        assert.equal(record.execution.harnessVersion, version);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
