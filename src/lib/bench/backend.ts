import type { ClaudeSubscriptionBackend, CodexSubscriptionBackend, CursorBackend, CursorLoginBackend, HarnessBackend, ResolvedTarget, SubscriptionBackend } from "./types.ts";

/** Auth is explicit; a provider name or model name never selects subscription auth. */
export function isCodexSubscriptionBackend<T extends HarnessBackend>(backend: T): backend is T & CodexSubscriptionBackend {
  return backend.auth === "chatgpt";
}

export function isClaudeSubscriptionBackend<T extends HarnessBackend>(backend: T): backend is T & ClaudeSubscriptionBackend {
  return backend.auth === "claude-subscription";
}

export function isCursorBackend<T extends HarnessBackend>(backend: T): backend is T & CursorBackend {
  return backend.auth === "cursor-login" || backend.auth === "cursor-api-key";
}

export function isCursorLoginBackend<T extends HarnessBackend>(backend: T): backend is T & CursorLoginBackend {
  return backend.auth === "cursor-login";
}

export function isSubscriptionBackend<T extends HarnessBackend>(backend: T): backend is T & SubscriptionBackend {
  return isCodexSubscriptionBackend(backend) || isClaudeSubscriptionBackend(backend) || isCursorLoginBackend(backend);
}

export function targetApiKeyEnv(target: ResolvedTarget): string | undefined {
  return target.kind === "llm" ? target.apiKeyEnv : target.backend.apiKeyEnv;
}

export function targetProviderLabel(target: ResolvedTarget): string {
  if (target.kind === "llm") return target.config.provider ?? "default";
  if (isCodexSubscriptionBackend(target.backend)) return "chatgpt-subscription";
  if (isClaudeSubscriptionBackend(target.backend)) return "claude-subscription";
  if (isCursorBackend(target.backend)) return target.backend.auth;
  return target.backend.provider;
}
