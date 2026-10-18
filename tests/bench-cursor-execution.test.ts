import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTarget } from "../src/lib/bench/executor.ts";
import { resolveTarget } from "../src/lib/bench/config.ts";
import type { ProcessRequest, ProcessResult } from "../src/lib/bench/types.ts";
import { makeCommandLab, writeJson } from "./helpers.ts";

test("Cursor executor probes original CLI without preload, then runs the frozen repaired launcher", { skip: process.platform !== "darwin" }, async () => {
  const { root } = makeCommandLab();
  writeJson(path.join(root, "harnesses/cursor.json"), { name: "cursor", adapter: "cursor-agent", executable: "/fake/cursor-agent", permission: "workspace-write", useHttp1ForAgent: true, nativeStallTimeoutMs: 300000, useCurrentUserHomeForLogin: true });
  writeJson(path.join(root, "targets/cursor.json"), { name: "cursor", kind: "harness", harness: "cursor", backend: { auth: "cursor-login", model: "claude-opus-5-5-high" } });
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  mkdirSync(workspace);
  const requests: ProcessRequest[] = [];
  const response = (stdout: string): ProcessResult => ({ stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1 });
  const result = await executeTarget({ root, target: resolveTarget(root, "cursor"), home, workspace, task: { name: "diagnostic", prompt: "test", timeoutMs: 5000, checks: [] } }, {
    runProcess: async request => {
      requests.push(request);
      if (request.args.includes("--version")) {
        assert.equal(request.executable, "/fake/cursor-agent");
        assert.ok(!request.env?.NODE_OPTIONS);
        assert.equal(request.env?.AGENT_CLI_CREDENTIAL_STORE, "memory");
        assert.notEqual(request.env?.HOME, homedir());
        return response("2026.07.23-e383d2b\n");
      }
      if (request.args.includes("status")) {
        assert.equal(request.executable, "/fake/cursor-agent");
        assert.equal(request.env?.HOME, homedir());
        assert.ok(!request.env?.NODE_OPTIONS);
        return response(JSON.stringify({ status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true }));
      }
      assert.equal(request.executable, "/bin/bash");
      assert.equal(request.env?.HOME, homedir());
      assert.equal(request.env?.CURSOR_CONFIG_DIR, path.join(home, ".cursor"));
      assert.ok(request.env?.NODE_OPTIONS?.includes("preload.cjs"));
      assert.ok(existsSync(path.join(home, "cursor-launcher.sh")));
      assert.ok(existsSync(path.join(home, "cursor-runtime/preload.cjs")));
      assert.equal(JSON.parse(readFileSync(path.join(home, "cursor-runtime/compatibility.json"), "utf8")).nativeStallTimeoutMs, 300000);
      assert.ok(request.args.includes("--sandbox"));
      assert.ok(!request.args.includes("--force"));
      assert.ok(request.timeoutMs <= 5000);
      return response([
        { type: "system", subtype: "init", session_id: "test", cwd: workspace, apiKeySource: "login" },
        { type: "result", subtype: "success", session_id: "test", is_error: false, result: "done" },
      ].map(value => JSON.stringify(value)).join("\n"));
    },
  });
  assert.equal(result.status, "completed", result.error ?? "");
  assert.equal(result.text, "done");
  assert.equal(requests.length, 4);
  assert.equal(result.harnessVersion, "2026.07.23-e383d2b");
});
