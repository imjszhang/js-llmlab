import path from "node:path";
import { cursorCommonArgs, cursorEnvironment } from "../cursor-account.ts";
import { planCursorShell } from "../cursor-shell.ts";
import { planCursorRuntime } from "../cursor-runtime.ts";
import { planCursorLauncher } from "../cursor-launcher.ts";
import type { HarnessContext, HarnessPlan, ResolvedCursorBackend, ResolvedHarnessTarget } from "../types.ts";

/** Cursor is a native service, independent of our API-provider protocols. */
export function planCursorAgent(
  target: ResolvedHarnessTarget & { backend: ResolvedCursorBackend },
  context: HarnessContext,
  apiKey?: string,
): HarnessPlan {
  const home = path.resolve(context.home);
  const workspace = path.resolve(context.workspace);
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if (inside(home, workspace) || inside(workspace, home)) throw new Error("Cursor Agent workspace 与临时 HOME 不能重叠");
  // Permission patterns have their own syntax; reject ambiguous paths rather than
  // silently allowing a broader directory than the frozen workspace.
  if (/[\u0000-\u001f\u007f*?()\[\]{}]/u.test(home + workspace)) throw new Error("Cursor Agent 工作路径包含不支持的权限模式字符");
  const writable = target.profile.permission === "workspace-write";
  const shell = planCursorShell(home);
  const launcher = planCursorLauncher(home, target.profile.executable);
  const runtime = target.profile.nativeStallTimeoutMs === undefined ? undefined : planCursorRuntime(home, target.profile.nativeStallTimeoutMs);
  const env = { ...cursorEnvironment(home, target.backend.auth, apiKey, target.profile.useCurrentUserHomeForLogin), ...shell.env, ...runtime?.env,
    GIT_CEILING_DIRECTORIES: workspace };
  const config = path.join(home, ".cursor");
  const tools = ["glob_tool_call", "grep_tool_call", "read_tool_call", "ls_tool_call",
    ...(writable ? ["shell_tool_call", "delete_tool_call", "edit_tool_call", "write_shell_stdin_tool_call"] : [])];
  return {
    route: "cursor-agent",
    files: [
      { path: path.join(config, "cli-config.json"), content: JSON.stringify({
        version: 1,
        editor: { vimMode: false },
        ...(target.profile.useHttp1ForAgent === undefined ? {} : { network: { useHttp1ForAgent: target.profile.useHttp1ForAgent } }),
        approvalMode: "allowlist",
        permissions: {
          // A Shell allow entry selects insecure_none in the pinned native CLI.
          // Let its sandbox decision preapprove only commands within our policy.
          allow: [`Read(${workspace}/**)`, ...(writable ? [`Write(${workspace}/**)`] : [])],
          deny: [`Read(${home}/**)`, `Write(${home}/**)`, `Write(${workspace}/.cursor/**)`, "Mcp(*:*)", "WebFetch(*)"],
        },
        sandbox: { mode: "enabled", networkAccess: "user_config_only" },
      }, null, 2) + "\n" },
      { path: path.join(config, "sandbox.json"), content: JSON.stringify({
        type: writable ? "workspace_readwrite" : "workspace_readonly",
        // This native version folds only the read-only/write and network fields
        // from the per-user file; readBoundary/additionalReadPaths are ignored.
        additionalReadonlyPaths: [path.join(home, "cursor-shell")],
        networkPolicy: { default: "deny", allow: [], deny: [] },
        networkPolicyStrict: true,
      }, null, 2) + "\n" },
      ...shell.files,
      ...launcher.files,
      ...(runtime?.files ?? []),
      ...(runtime === undefined ? [] : [{ path: path.join(home, "cursor-runtime", "compatibility.json"), content: JSON.stringify(runtime.compatibility, null, 2) + "\n" }]),
    ],
    process: {
      executable: launcher.executable,
      args: [...launcher.args, ...cursorCommonArgs(), "-p", "--output-format", "stream-json", "--model", target.backend.model,
        "--sandbox", "enabled", "--trust", "--disable-indexing", "--disable-codebase-ref",
        "--allowed-tools", tools.join(","), ...(writable ? [] : ["--mode", "ask"])],
      cwd: workspace, env, stdin: context.prompt, timeoutMs: context.timeoutMs, terminationGraceMs: 4000,
    },
  };
}
