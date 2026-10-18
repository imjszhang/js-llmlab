import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadHarness, resolveTarget } from "../src/lib/bench/config.ts";
import { planHarness } from "../src/lib/bench/harness.ts";
import { planCursorShell } from "../src/lib/bench/cursor-shell.ts";
import { runProcess } from "../src/lib/bench/process.ts";
import { makeCommandLab, writeJson } from "./helpers.ts";

test("Cursor transport choice survives resolution into native config without changing permissions", () => {
  const { root } = makeCommandLab();
  const profile = { name: "cursor", adapter: "cursor-agent", executable: "cursor-agent", permission: "workspace-write" };
  writeJson(path.join(root, "targets/cursor.json"), { name: "cursor", kind: "harness", harness: "cursor", backend: { auth: "cursor-login", model: "claude-opus-5-5-high" } });
  for (const choice of [undefined, false, true]) {
    writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, ...(choice === undefined ? {} : { useHttp1ForAgent: choice }) });
    const target = resolveTarget(root, "cursor");
    assert.equal(target.kind, "harness");
    if (target.kind !== "harness") throw new Error("expected harness");
    const plan = planHarness(target, { workspace: path.join(root, "work"), home: path.join(root, "home"), prompt: "test", timeoutMs: 5000 });
    const native = plan.files.find(file => file.path.endsWith("cli-config.json"));
    assert.ok(native);
    assert.deepEqual(JSON.parse(native.content).network, choice === undefined ? undefined : { useHttp1ForAgent: choice });
    assert.equal(plan.process.env?.NODE_USE_ENV_PROXY, "1");
    assert.equal(plan.process.env?.NODE_OPTIONS, undefined);
    assert.ok(!plan.process.args.includes("--exclude-workspace-context"));
    assert.equal(plan.process.args[plan.process.args.indexOf("--sandbox") + 1], "enabled");
    assert.ok(!plan.process.args.includes("--force"));
  }
  writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, nativeStallTimeoutMs: 300000 });
  const repaired = resolveTarget(root, "cursor");
  if (repaired.kind !== "harness") throw new Error("expected harness");
  const repairedPlan = planHarness(repaired, { workspace: path.join(root, "work"), home: path.join(root, "home"), prompt: "test", timeoutMs: 5000 });
  assert.equal(repaired.profile.nativeStallTimeoutMs, 300000);
  assert.ok(repairedPlan.process.env?.NODE_OPTIONS?.includes("preload.cjs"));
  assert.equal(repairedPlan.process.timeoutMs, 5000, "task budget remains authoritative");
  const compatibility = repairedPlan.files.find(file => file.path.endsWith("compatibility.json"));
  assert.ok(compatibility);
  assert.equal(JSON.parse(compatibility.content).nativeStallTimeoutMs, 300000);
  for (const invalid of ["300000", null, 29999, 300001, 30000.5]) {
    writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, nativeStallTimeoutMs: invalid });
    assert.throws(() => loadHarness(root, "cursor"), /nativeStallTimeoutMs/u);
  }
  writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, adapter: "codex", nativeStallTimeoutMs: 300000 });
  assert.throws(() => loadHarness(root, "cursor"), /nativeStallTimeoutMs/u);
  for (const invalid of [{ useCurrentUserHomeForLogin: "true" }, { adapter: "codex", useCurrentUserHomeForLogin: true }]) {
    writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, ...invalid });
    assert.throws(() => loadHarness(root, "cursor"), /useCurrentUserHomeForLogin/u);
  }
  for (const invalid of [{ adapter: "codex", useHttp1ForAgent: true }, { useHttp1ForAgent: "true" }]) {
    writeJson(path.join(root, "harnesses/cursor.json"), { ...profile, ...invalid });
    assert.throws(() => loadHarness(root, "cursor"), /useHttp1ForAgent/u);
  }
});

test("Cursor shell preserves transport proxies while dropping other credentials and unapproved proxy variables", async () => {
  const { root } = makeCommandLab();
  const home = path.join(root, "home");
  const plan = planCursorShell(home);
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, { mode: file.mode ?? 0o600 });
  }
  const values = { HTTP_PROXY: "http://localhost:8081", HTTPS_PROXY: "http://localhost:8082", ALL_PROXY: "socks5://localhost:8083", NO_PROXY: "localhost", http_proxy: "http://localhost:8084", https_proxy: "http://localhost:8085", all_proxy: "socks5://localhost:8086", no_proxy: "127.0.0.1" };
  const result = await runProcess({ executable: path.join(home, "cursor-shell/bin/bash"), args: ["-c", 'exec "$1" -e \'console.log(JSON.stringify(process.env))\'', "test", process.execPath], cwd: root, timeoutMs: 5000,
    env: { ...plan.env, ...values, FAKE_API_KEY: "test-secret", CURSOR_AUTH_TOKEN: "test-token", OTHER_PROXY: "unapproved", BASH_ENV: "/does/not/exist" } });
  assert.equal(result.exitCode, 0, result.stderr);
  const env = JSON.parse(result.stdout);
  for (const [name, value] of Object.entries(values)) assert.equal(env[name], value);
  for (const name of ["FAKE_API_KEY", "CURSOR_AUTH_TOKEN", "OTHER_PROXY", "BASH_ENV"]) assert.equal(env[name], undefined);
  assert.equal(env.HOME, home);
});
