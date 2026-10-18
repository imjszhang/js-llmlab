import path from "node:path";
import { homedir } from "node:os";
import { claudeSubscriptionEnvironment } from "../claude-account.ts";
import { planClaudeSubscriptionShell } from "../claude-shell.ts";
import type { HarnessContext, HarnessPlan, ResolvedHarnessTarget, ResolvedClaudeSubscriptionBackend } from "../types.ts";

/** Keep native auth in its original namespace; never extract or copy OAuth credentials. */
export function planClaudeSubscription(
  target: ResolvedHarnessTarget & { backend: ResolvedClaudeSubscriptionBackend },
  context: HarnessContext,
): HarnessPlan {
  const home = path.resolve(context.home);
  const workspace = path.resolve(context.workspace);
  const authDir = target.backend.claudeConfigDir;
  // A custom auth directory overlapping the workspace would expose credentials to
  // file tools before shell sandboxing. Reject it even for read-only profiles.
  const overlaps = (left: string, right: string): boolean => {
    const relative = path.relative(left, right);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if (overlaps(authDir, workspace) || overlaps(workspace, authDir) || overlaps(authDir, home) || overlaps(home, authDir)) {
    throw new Error("Claude 订阅认证目录不能与本轮 workspace/home 重叠");
  }
  const shell = planClaudeSubscriptionShell(target.backend, home);
  const env = { ...claudeSubscriptionEnvironment(target.backend, home), ...shell.env };
  // Pin the official transport; inherited provider/token/custom endpoint env is
  // excluded by the process runner. CLI manages and refreshes its own OAuth.
  env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  env.CLAUDE_CODE_TMPDIR = path.join(home, "claude-tmp");
  env.CLAUDE_CODE_DEBUG_LOGS_DIR = path.join(home, "claude-debug.log");
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  const tools = target.profile.permission === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash";
  const protectedPaths = [authDir, path.join(path.dirname(authDir), ".claude.json"), path.join(homedir(), "Library", "Keychains")];
  const settings = path.join(home, "claude-settings", "settings.json");
  return {
    route: "anthropic-messages",
    files: [{ path: settings, content: JSON.stringify({
      disableAllHooks: true,
      permissions: { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true },
      ...(target.profile.permission === "workspace-write" ? { sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        filesystem: { denyRead: protectedPaths, denyWrite: [...protectedPaths, path.join(home, "claude-shell"), path.dirname(settings)] },
        credentials: { envVars: [
          "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
          "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy",
        ].map((name) => ({ name, mode: "deny" })) },
      } } : {}),
    }, null, 2) + "\n" }, ...shell.files],
    process: {
      executable: target.profile.executable,
      // --bare disables keychain/OAuth and is only valid for the API-key plan.
      args: ["-p", "--output-format", "stream-json", "--verbose", "--safe-mode", "--restricted",
        "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--permission-prompts", "none", "--tools", tools, "--allowedTools", tools,
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", settings,
        "--setting-sources", "", "--model", target.backend.model],
      cwd: workspace, env, stdin: context.prompt, timeoutMs: context.timeoutMs,
    },
  };
}
