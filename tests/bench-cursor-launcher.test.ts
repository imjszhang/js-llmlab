import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { planCursorLauncher } from "../src/lib/bench/cursor-launcher.ts";
import { planCursorShell } from "../src/lib/bench/cursor-shell.ts";
import { runProcess } from "../src/lib/bench/process.ts";
import { makeLabRoot, writeText } from "./helpers.ts";

function materialize(files: Array<{ path: string; content: string; mode?: number }>): void {
  for (const file of files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    if (file.mode !== undefined) chmodSync(file.path, file.mode);
  }
}

test("Cursor launcher rejects invalid inputs without resolving or executing a native CLI", () => {
  for (const home of ["relative", "/tmp/nul\0home", "/tmp/line\nhome", "/tmp/delete\u007fhome"]) {
    assert.throws(() => planCursorLauncher(home, "fake-agent"), /HOME/u);
  }
  for (const executable of ["", "  ", "fake\0agent", "fake\nagent", "fake\tagent", "fake\u007fagent"]) {
    assert.throws(() => planCursorLauncher("/tmp/isolated", executable), /executable/u);
  }
  const plan = planCursorLauncher("/tmp/not-created/../isolated", "missing-native-agent");
  assert.equal(plan.executable, "/bin/bash");
  assert.deepEqual(plan.args, ["-p", "/tmp/isolated/cursor-launcher.sh"]);
  assert.equal(plan.files[0]?.mode, 0o700);
});

test("Cursor native entry keeps its authentication and preload while tool bash keeps the isolated environment", { skip: process.platform === "win32" }, async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const isolatedHome = path.join(root, "isolated 'home $(printf unexpected)");
  const nativeHome = path.join(root, "native-home");
  const nativeBin = path.join(root, "native-bin");
  const nativeName = "fake-agent's-$(printf-unexpected)";
  const native = path.join(nativeBin, nativeName);
  const startupFile = path.join(root, "must-not-load.bash");
  writeText(startupFile, "exit 88\n");
  materialize([{ path: native, mode: 0o700, content: [
    "#!/usr/bin/env bash",
    "set -eu",
    'printf "native-home=%s\\nnative-store=%s\\nnative-preload=%s\\n" "$HOME" "$AGENT_CLI_CREDENTIAL_STORE" "$NODE_OPTIONS"',
    'printf "native-path=%s\\n" "$PATH"',
    'for native_arg in "$@"; do printf "arg=%s\\n" "$native_arg"; done',
    'bash -c \'printf "tool-home=%s\\ntool-store=%s\\ntool-key=%s\\ntool-preload=%s\\n" "$HOME" "${AGENT_CLI_CREDENTIAL_STORE-unset}" "${CURSOR_API_KEY-unset}" "${NODE_OPTIONS-unset}"\'',
    "",
  ].join("\n") }]);
  const shell = planCursorShell(isolatedHome);
  materialize(shell.files);
  const shellPath = `${path.dirname(shell.env.SHELL ?? "")}${path.delimiter}${nativeBin}${path.delimiter}/usr/bin:/bin`;
  for (const executable of [nativeName, native]) {
    await t.test(path.isAbsolute(executable) ? "absolute native path" : "native resolved from PATH", async () => {
      const plan = planCursorLauncher(isolatedHome, executable);
      materialize(plan.files);
      const result = await runProcess({ executable: plan.executable,
        args: [...plan.args, "--model", "literal ' $(printf unexpected)"], cwd: root,
        env: { ...shell.env, HOME: nativeHome, USERPROFILE: nativeHome, PATH: shellPath,
          AGENT_CLI_CREDENTIAL_STORE: "memory", CURSOR_API_KEY: "fake-native-only",
          NODE_OPTIONS: "--require /fake/trusted-preload.cjs", BASH_ENV: startupFile }, timeoutMs: 3000 });
      assert.equal(result.error, null);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.stdout.trimEnd().split("\n"), [
        `native-home=${nativeHome}`, "native-store=memory", "native-preload=--require /fake/trusted-preload.cjs",
        `native-path=${shellPath}`, "arg=--model", "arg=literal ' $(printf unexpected)",
        `tool-home=${isolatedHome}`, "tool-store=unset", "tool-key=unset", "tool-preload=unset",
      ]);
    });
  }
});

test("Cursor launcher fails clearly for missing commands and shell builtins", { skip: process.platform === "win32" }, async (t) => {
  const root = makeLabRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [executable, code] of [["missing-js-llmlab-cursor-launcher", 127], ["printf", 126]] as const) {
    const plan = planCursorLauncher(path.join(root, "home"), executable);
    materialize(plan.files);
    const result = await runProcess({ executable: plan.executable, args: plan.args, cwd: root,
      env: { PATH: "/usr/bin:/bin" }, timeoutMs: 2000 });
    assert.equal(result.exitCode, code);
    assert.match(result.stderr, /Cursor Agent native launcher/u);
  }
});
