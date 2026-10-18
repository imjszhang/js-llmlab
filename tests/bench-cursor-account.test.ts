import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runCursorMetadata } from "../src/commands/cursor.ts";
import { CURSOR_AGENT_VERSION, cursorEnvironment, listCursorModels, readCursorAccount } from "../src/lib/bench/cursor-account.ts";
import type { ProcessRequest, ProcessResult } from "../src/lib/bench/types.ts";
import { makeLabRoot, withEnvAsync, writeJson } from "./helpers.ts";

const models = "Available models\nclaude-opus-5-5-high - Claude Opus 5.5 High (default)\n\nTip: use --model <id> to select a model.\n";
const nativeStatus = JSON.stringify({ status: "authenticated", isAuthenticated: true,
  hasAccessToken: true, hasRefreshToken: true, email: "private@example.invalid", accessToken: "do-not-return" });

function success(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1 };
}

function assertIsolatedState(request: ProcessRequest): string {
  const home = path.join(request.cwd, "home");
  for (const [name, suffix] of Object.entries({ CURSOR_CONFIG_DIR: ".cursor", CURSOR_DATA_DIR: ".cursor-data",
    XDG_CONFIG_HOME: ".config", XDG_CACHE_HOME: ".cache", XDG_DATA_HOME: ".local/share", XDG_STATE_HOME: ".local/state",
    NODE_COMPILE_CACHE: ".cache/cursor-compile-cache" })) {
    assert.equal(request.env?.[name], path.join(home, suffix));
  }
  return home;
}

test("Cursor current-user login keeps only native HOME while preserving opt-in and isolated state", { skip: process.platform !== "darwin" }, () => {
  const before = { ...process.env };
  const home = path.join(os.tmpdir(), "cursor-isolated-metadata-home");
  const legacy = cursorEnvironment(home, "cursor-login");
  const explicitOff = cursorEnvironment(home, "cursor-login", undefined, false);
  const current = cursorEnvironment(home, "cursor-login", undefined, true);
  assert.deepEqual(explicitOff, legacy);
  assert.equal(legacy.HOME, home);
  assert.equal(current.HOME, os.homedir());
  assert.equal(current.USERPROFILE, os.homedir());
  assert.equal(current.AGENT_CLI_CREDENTIAL_STORE, "default");
  assert.deepEqual(current, { ...legacy, HOME: os.homedir(), USERPROFILE: os.homedir() });
  assert.ok(isDeepStrictEqual({ ...process.env }, before), "parent environment must not change");
});

test("Cursor login status and models share current-user context while version probes stay isolated and credential-free", { skip: process.platform !== "darwin" }, async () => {
  const before = { ...process.env };
  for (const kind of ["status", "models"] as const) {
    const requests: ProcessRequest[] = [];
    const options = { executable: "fake-cursor-agent", auth: "cursor-login" as const, useCurrentUserHomeForLogin: true };
    const deps = { runProcess: async (request: ProcessRequest) => {
      requests.push(request);
      const isolatedHome = assertIsolatedState(request);
      assert.equal(request.executable, "fake-cursor-agent");
      assert.equal(request.env?.CURSOR_API_KEY, undefined);
      assert.equal(request.env?.NODE_OPTIONS, undefined);
      if (request.args.includes("--version")) {
        assert.equal(request.env?.HOME, isolatedHome);
        assert.notEqual(request.env?.HOME, os.homedir());
        assert.equal(request.env?.AGENT_CLI_CREDENTIAL_STORE, "memory");
        return success(CURSOR_AGENT_VERSION);
      }
      assert.equal(request.env?.HOME, os.homedir());
      assert.equal(request.env?.USERPROFILE, os.homedir());
      assert.equal(request.env?.AGENT_CLI_CREDENTIAL_STORE, "default");
      assert.ok(request.args.includes(kind));
      return success(kind === "status" ? nativeStatus : models);
    } };
    if (kind === "status") {
      assert.deepEqual(await readCursorAccount(options, deps), { auth: "cursor-login", credentialPresent: true, verified: false });
    } else {
      assert.deepEqual(await listCursorModels(options, deps), [{ id: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 High", isDefault: true }]);
    }
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(existsSync(request.cwd), false, "temporary metadata state is removed");
  }
  assert.ok(isDeepStrictEqual({ ...process.env }, before), "parent environment must not change");
});

test("Cursor API-key metadata ignores current-user login mode and keeps the key out of version probes", async () => {
  const before = { ...process.env };
  const home = path.join(os.tmpdir(), "cursor-api-key-isolated-home");
  assert.deepEqual(cursorEnvironment(home, "cursor-api-key", "fake-selected-key", true),
    cursorEnvironment(home, "cursor-api-key", "fake-selected-key", false));
  const requests: ProcessRequest[] = [];
  const result = await readCursorAccount({ executable: "fake-cursor-agent", auth: "cursor-api-key", apiKey: "fake-selected-key",
    useCurrentUserHomeForLogin: true }, { runProcess: async (request) => {
      requests.push(request);
      const isolatedHome = assertIsolatedState(request);
      assert.equal(request.env?.HOME, isolatedHome);
      assert.equal(request.env?.USERPROFILE, isolatedHome);
      assert.notEqual(request.env?.HOME, os.homedir());
      assert.equal(request.env?.AGENT_CLI_CREDENTIAL_STORE, "memory");
      if (request.args.includes("--version")) {
        assert.equal(request.env?.CURSOR_API_KEY, undefined);
        return success(CURSOR_AGENT_VERSION);
      }
      assert.equal(request.env?.CURSOR_API_KEY, "fake-selected-key");
      return success(models);
    } });
  assert.deepEqual(result, { auth: "cursor-api-key", credentialPresent: true, verified: true });
  assert.equal(requests.length, 2);
  assert.ok(isDeepStrictEqual({ ...process.env }, before), "parent environment must not change");
});

test("Cursor metadata command forwards its profile login context without exposing native identity", { skip: process.platform !== "darwin" }, async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, "harnesses/cursor-agent.json"), { name: "cursor-agent", adapter: "cursor-agent",
    executable: "fake-cursor-agent", permission: "read-only", useCurrentUserHomeForLogin: true });
  const output: string[] = [];
  await runCursorMetadata("status", { json: true }, { root, log: (text) => output.push(text), runProcess: async (request) => {
    if (request.args.includes("--version")) {
      assert.notEqual(request.env?.HOME, os.homedir());
      return success(CURSOR_AGENT_VERSION);
    }
    assert.equal(request.env?.HOME, os.homedir());
    assertIsolatedState(request);
    return success(nativeStatus);
  } });
  assert.deepEqual(JSON.parse(output[0] ?? ""), { auth: "cursor-login", credentialPresent: true, verified: false });
  assert.doesNotMatch(output.join("\n"), /private@example|do-not-return|accessToken/u);

  await withEnvAsync({ CURSOR_METADATA_TEST_KEY: "fake-command-key" }, async () => {
    await runCursorMetadata("models", { auth: "cursor-api-key", apiKeyEnv: "CURSOR_METADATA_TEST_KEY", json: true },
      { root, log: () => {}, runProcess: async (request) => {
        const isolatedHome = assertIsolatedState(request);
        assert.equal(request.env?.HOME, isolatedHome);
        if (request.args.includes("--version")) return success(CURSOR_AGENT_VERSION);
        assert.equal(request.env?.CURSOR_API_KEY, "fake-command-key");
        return success(models);
      } });
  });
});
