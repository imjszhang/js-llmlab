import chalk from "chalk";
import {
  formatError,
  runCompletion,
  withRetries,
  type Completer,
  type RetryOptions,
} from "../lib/client.ts";
import { findProjectRoot } from "../lib/paths.ts";

/**
 * 命令层可注入的依赖。CLI 入口不传，全部取默认；测试传临时根目录、
 * 假 completer 和静默日志，让编排逻辑离线跑。
 */
export type CommandDeps = {
  root?: string;
  /** 原始 completer；resolveDeps 会按配置的 maxRetries 包一层重试。 */
  complete?: Completer;
  /** 重试退避基数（ms）；测试传 0 不睡觉。 */
  retryBaseDelayMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export type ResolvedDeps = {
  root: string;
  complete: Completer;
  log: (line: string) => void;
  error: (line: string) => void;
};

export function resolveDeps(deps: CommandDeps | undefined): ResolvedDeps {
  const log =
    deps?.log ??
    ((line: string): void => {
      console.log(line);
    });
  const error =
    deps?.error ??
    ((line: string): void => {
      console.error(line);
    });
  const retryOptions: RetryOptions = {
    onRetry: ({ config, attempt, maxRetries, error: cause }) => {
      log(chalk.yellow(`重试 ${String(attempt)}/${String(maxRetries)} ${config.name}：${formatError(cause)}`));
    },
  };
  if (deps?.retryBaseDelayMs !== undefined) {
    retryOptions.baseDelayMs = deps.retryBaseDelayMs;
  }
  return {
    root: deps?.root ?? findProjectRoot(),
    complete: withRetries(deps?.complete ?? runCompletion, retryOptions),
    log,
    error,
  };
}
