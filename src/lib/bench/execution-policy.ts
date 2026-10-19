import path from "node:path";
import { proxyEnvironment } from "./network-environment.ts";
import type { HarnessContext, HarnessPlan, ResolvedHarnessTarget } from "./types.ts";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Applied before both preview and execution; no late process-wrapper mutations. */
export function applyExecutionPolicy(target: ResolvedHarnessTarget, context: HarnessContext, plan: HarnessPlan): HarnessPlan {
  const policy = target.profile.execution;
  if (!policy) return plan;
  if (target.backend.auth === "claude-subscription" && (policy.fullAccess || policy.proxy === "claude-shell" || policy.pinModelAliases)) throw new Error("Claude subscription does not support API video execution policy");
  const env = plan.process.env ?? {};
  plan.process.env = env;
  if (policy.maxOutputBytes !== undefined) plan.process.maxOutputBytes = policy.maxOutputBytes;
  if (policy.proxy !== undefined) Object.assign(env, proxyEnvironment());
  if (policy.proxy === "claude-shell") {
    if (target.profile.adapter !== "claude-code") throw new Error("claude-shell requires Claude Code");
    const file = path.join(context.home, "claude", "network-env.sh");
    plan.files.push({ path: file, mode: 0o600, content: Object.entries(proxyEnvironment()).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n") + "\n" });
    env.CLAUDE_ENV_FILE = file;
  }
  if (policy.pinModelAliases) {
    if (target.profile.adapter !== "claude-code") throw new Error("pinModelAliases requires Claude Code");
    for (const key of ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) env[key] = target.backend.model;
  }
  if (!policy.fullAccess) return plan;
  if (target.profile.permission !== "workspace-write") throw new Error("fullAccess requires workspace-write");
  const args = plan.process.args;
  const remove = (flag: string, value = false): void => { const i = args.indexOf(flag); if (i >= 0) args.splice(i, value ? 2 : 1); };
  if (target.profile.adapter === "claude-code") {
    remove("--bare"); remove("--restricted"); remove("--allowedTools", true);
    args[args.indexOf("--permission-mode") + 1] = "bypassPermissions";
    args[args.indexOf("--tools") + 1] = "default";
    args.push("--dangerously-skip-permissions");
    const settings = plan.files.find((file) => file.path.endsWith("/claude/settings.json"));
    if (!settings) throw new Error("Missing Claude settings");
    settings.content = JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: "bypassPermissions", blockReadsOutsideWorkingDirectories: false }, sandbox: { enabled: false } }, null, 2) + "\n";
  } else if (target.profile.adapter === "cursor-agent") {
    args[args.indexOf("--sandbox") + 1] = "disabled";
    remove("--allowed-tools", true);
    args.push("--force");
    // Native authentication already selects HOME. Retain host tooling PATH explicitly.
    env.PATH = process.env.PATH ?? "/usr/bin:/bin";
    env.SHELL = "/bin/bash";
    for (const file of plan.files) {
      if (file.path.endsWith("/cli-config.json")) {
        const config = JSON.parse(file.content) as Record<string, unknown>;
        config.permissions = { allow: ["Read(*)", "Write(*)", "Shell(*)", "WebFetch(*)"], deny: ["Mcp(*:*)"] };
        config.sandbox = { mode: "disabled" };
        file.content = JSON.stringify(config, null, 2) + "\n";
      }
      if (file.path.endsWith("/sandbox.json")) file.content = JSON.stringify({ type: "insecure_none", networkPolicy: { default: "allow", allow: [], deny: [] } }) + "\n";
    }
  } else throw new Error("fullAccess supports only Claude Code and Cursor Agent");
  return plan;
}
