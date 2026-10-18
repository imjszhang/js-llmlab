import path from "node:path";

type ClaudeShellOptions = {
  claudeConfigDir: string;
  claudeConfigDirMode: "default" | "explicit";
};
type ClaudeShellPlan = {
  env: Record<string, string>;
  files: Array<{ path: string; content: string; mode?: 0o600 | 0o700 }>;
};

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} 必须是绝对路径`);
  return path.resolve(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Native Claude Code 2.1.296 builds a shell snapshot with a login shell, then
 * explicitly sources an absolute ~/.bashrc or ~/.zshrc computed by its parent.
 * Safe/restricted mode does not suppress this path. A default-auth process must
 * keep the original HOME to preserve the native Keychain namespace, so merely
 * changing the shell child's HOME or passing --noprofile is insufficient.
 *
 * This macOS-only wrapper uses the documented CLAUDE_CODE_SHELL override and
 * Seatbelt to deny the original shell startup paths during that trusted native
 * initialization. It is not a general process sandbox: the task's separate
 * native tool sandbox must protect auth paths and deny writes to these files.
 * A CLI that no longer accepts the shell override, a missing sandbox-exec, or
 * unavailable platform isolation must not silently fall back to a host shell.
 * Explicit auth directories already run with an isolated HOME and need no
 * default-auth shell bridge. No paths are read and no processes start here.
 */
export function planClaudeSubscriptionShell(options: ClaudeShellOptions, home: string): ClaudeShellPlan {
  const configDir = absolutePath(options.claudeConfigDir, "Claude Code 登录目录");
  const isolatedHome = absolutePath(home, "Claude Code 临时 HOME");
  if (options.claudeConfigDirMode === "explicit") return { env: {}, files: [] };
  if (options.claudeConfigDirMode !== "default" || path.basename(configDir) !== ".claude") {
    throw new Error("Claude Code 默认登录目录必须是原 HOME 下的 .claude");
  }
  if (process.platform !== "darwin") {
    throw new Error("当前平台无法隔离 Claude Code 默认登录的 shell 初始化；请先用显式 CLAUDE_CONFIG_DIR 原生登录，再在 target 中配置该目录");
  }
  const originalHome = path.dirname(configDir);
  const wrapper = path.join(isolatedHome, "claude-shell", "subscription-bash");
  const profile = path.join(isolatedHome, "claude-shell", "profile.sb");
  const blocked = [
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
    ".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout",
  ].map((name) => path.join(originalHome, name));
  // JSON string escaping covers the quotes and backslashes used by SBPL path
  // strings. Control characters were rejected before producing either file.
  const policy = [
    "(version 1)",
    "(allow default)",
    "(deny file-read*",
    ...blocked.map((name) => `  (literal ${JSON.stringify(name)})`),
    ")",
    "",
  ].join("\n");
  const script = [
    "#!/bin/bash -p",
    "set -eu",
    "unset BASH_ENV ENV",
    `export HOME=${shellQuote(isolatedHome)}`,
    `export USERPROFILE=${shellQuote(isolatedHome)}`,
    `export ZDOTDIR=${shellQuote(isolatedHome)}`,
    `exec /usr/bin/sandbox-exec -f ${shellQuote(profile)} /bin/bash --noprofile --norc "$@"`,
    "",
  ].join("\n");
  return {
    env: { CLAUDE_CODE_SHELL: wrapper },
    files: [
      { path: profile, content: policy, mode: 0o600 },
      { path: wrapper, content: script, mode: 0o700 },
    ],
  };
}
