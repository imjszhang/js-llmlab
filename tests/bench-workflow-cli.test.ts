import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runBench, runBenchLs, runBenchReport, runBenchShow, runTasksInit, runTasksValidate } from "../src/commands/bench.ts";
import { createFakeCompleter, throwingCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync, writeJson } from "./helpers.ts";

function workflowLab() {
  const lab = makeCommandLab();
  writeJson(path.join(lab.root, "targets/direct.json"), { name: "direct", kind: "llm", config: "a" });
  for (const name of ["one", "two"]) writeJson(path.join(lab.root, `tasks/${name}.json`), {
    name, prompt: `Answer OK for ${name}.`, checks: [{ kind: "output-contains", text: "OK" }],
  });
  writeJson(path.join(lab.root, "bench-suites/demo.json"), {
    name: "demo", tasks: ["one", "two"], targets: ["direct"], repeat: 2, concurrency: 2,
  });
  return lab;
}

test("bench command requires exactly a suite or a task/targets pair before any execution", async () => {
  const { root } = workflowLab();
  try {
    for (const options of [{}, { task: "one" }, { targets: "direct" }, { suite: "demo", task: "one" },
      { suite: "demo", targets: "direct" }, { task: "one", targets: "direct", timeoutMs: "0" },
      { task: "one", targets: "direct", timeoutMs: "1.5" }]) {
      await assert.rejects(runBench(options, { root, complete: throwingCompleter(), log: () => {} }), /suite|task|targets|timeout-ms/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite CLI dry-run validates an entire plan without keys, processes or data writes", async () => {
  const { root, env } = workflowLab();
  rmSync(path.join(root, "data"), { recursive: true });
  try {
    await withEnvAsync({ ...env, TEST_KEY: undefined }, async () => {
      const logs: string[] = [];
      const result = await runBench({ suite: "demo", timeoutMs: "7000", dryRun: true }, {
        root, log: (text) => logs.push(text), complete: throwingCompleter(),
        runProcess: () => { throw new Error("No process allowed"); },
      });
      assert.equal(result, null);
      assert.match(logs.join("\n"), /one/u);
      assert.match(logs.join("\n"), /two/u);
      assert.match(logs.join("\n"), /7000/u);
      assert.equal(existsSync(path.join(root, "data")), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite dry-run redacts credentials referenced by an arbitrary provider environment name", async () => {
  const { root, env } = workflowLab();
  writeJson(path.join(root, "providers/test.json"), { name: "test", baseURL: "https://example.test/v1", apiKeyEnv: "CUSTOM_AUTH", model: "demo", maxRetries: 0 });
  writeJson(path.join(root, "tasks/one.json"), { name: "one", prompt: "Echo fixture-credential-value", checks: [] });
  try {
    await withEnvAsync({ ...env, CUSTOM_AUTH: "fixture-credential-value" }, async () => {
      const logs: string[] = [];
      await runBench({ suite: "demo", dryRun: true }, { root, log: (text) => logs.push(text), complete: throwingCompleter() });
      assert.doesNotMatch(logs.join("\n"), /fixture-credential-value/u);
      assert.match(logs.join("\n"), /Echo \*\*\*/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suite command results are discoverable and reportable alongside old b_id records", async () => {
  const { root, env } = workflowLab();
  try {
    await withEnvAsync(env, async () => {
      const logs: string[] = [];
      const deps = { root, complete: createFakeCompleter({}, { text: "OK" }).complete,
        log: (text: string) => logs.push(text), error: () => {} };
      const result = await runBench({ suite: "demo" }, deps);
      assert.ok(result);
      assert.equal(result.failed, false);
      assert.match(result.spec.id, /^e_/u);
      runBenchLs(deps);
      runBenchShow(result.spec.id, deps);
      const child = result.spec.benchmarks[0];
      assert.ok(child);
      runBenchShow(child.id, deps);
      runBenchReport([result.spec.id, child.id, child.id], { format: "json" }, deps);
      const parsed: unknown = JSON.parse(logs.at(-1) ?? "{}");
      assert.ok(typeof parsed === "object" && parsed !== null);
      assert.match(logs.join("\n"), new RegExp(result.spec.id, "u"));
      assert.match(logs.join("\n"), new RegExp(child.id, "u"));
      const specBefore = readFileSync(path.join(root, "data/benchmarks", child.id, "spec.json"), "utf8");
      const output = path.join(root, "reports/analysis.csv");
      runBenchReport([result.spec.id], { format: "csv", output }, deps);
      const csv = readFileSync(output, "utf8");
      assert.match(csv, /direct/u);
      assert.throws(() => runBenchReport([result.spec.id], { output }, deps), /EEXIST/u);
      assert.equal(readFileSync(output, "utf8"), csv);
      assert.equal(readFileSync(path.join(root, "data/benchmarks", child.id, "spec.json"), "utf8"), specBefore);
      assert.throws(() => runBenchReport([child.id], { format: "html" }, deps), /format/u);
      assert.throws(() => runBenchReport([], {}, deps), /至少/u);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task CLI creates and validates all template kinds without a model", async () => {
  const { root } = makeCommandLab();
  try {
    const logs: string[] = [];
    const deps = { root, log: (text: string) => logs.push(text), error: (text: string) => logs.push(text) };
    for (const template of ["repair", "data", "answer"]) {
      runTasksInit(`new-${template}`, template, deps);
      assert.equal(await runTasksValidate(`new-${template}`, false, deps), true);
    }
    assert.equal(await runTasksValidate(undefined, true, deps), true);
    await assert.rejects(runTasksValidate(undefined, false, deps), /任务名/u);
    await assert.rejects(runTasksValidate("new-data", true, deps), /不能/u);
    assert.throws(() => runTasksInit("new-data", "data", deps));
    assert.throws(() => runTasksInit("new-other", "other", deps), /template/u);
    assert.equal(await runTasksValidate("missing", false, deps), false);
    assert.match(logs.join("\n"), /new-answer/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
