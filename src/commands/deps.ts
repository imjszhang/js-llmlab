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
 *
 * 输出分三路：`log` 是 stdout 整行（成稿、表格），`write` 是 stdout 不换行（流式增量），
 * `error` 是 stderr 整行（进度、提示、报错）。管道里只拿 stdout 就只有成稿。
 */
export type CommandDeps = {
  root?: string;
  /** 原始 completer；resolveDeps 会按配置的 maxRetries 包一层重试。 */
  complete?: Completer;
  /** 重试退避基数（ms）；测试传 0 不睡觉。 */
  retryBaseDelayMs?: number;
  log?: (line: string) => void;
  write?: (chunk: string) => void;
  error?: (line: string) => void;
  /** stderr 不换行（流式思维链）。 */
  writeErr?: (chunk: string) => void;
  /** stderr 是否是终端；决定要不要打进度。测试里显式传。 */
  isTTY?: boolean;
  /** 非流式等待时每隔多久打一行进度（ms）；缺省 5000。 */
  progressIntervalMs?: number;
};

export type ResolvedDeps = {
  root: string;
  complete: Completer;
  log: (line: string) => void;
  write: (chunk: string) => void;
  error: (line: string) => void;
  writeErr: (chunk: string) => void;
  isTTY: boolean;
  progressIntervalMs: number;
};

export const DEFAULT_PROGRESS_INTERVAL_MS = 5000;

export function resolveDeps(deps: CommandDeps | undefined): ResolvedDeps {
  const log =
    deps?.log ??
    ((line: string): void => {
      console.log(line);
    });
  const write =
    deps?.write ??
    ((chunk: string): void => {
      process.stdout.write(chunk);
    });
  const writeErr =
    deps?.writeErr ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });
  const error =
    deps?.error ??
    ((line: string): void => {
      console.error(line);
    });
  const retryOptions: RetryOptions = {
    onRetry: ({ config, attempt, maxRetries, error: cause }) => {
      error(chalk.yellow(`重试 ${String(attempt)}/${String(maxRetries)} ${config.name}：${formatError(cause)}`));
    },
  };
  if (deps?.retryBaseDelayMs !== undefined) {
    retryOptions.baseDelayMs = deps.retryBaseDelayMs;
  }
  return {
    root: deps?.root ?? findProjectRoot(),
    complete: withRetries(deps?.complete ?? runCompletion, retryOptions),
    log,
    write,
    error,
    writeErr,
    isTTY: deps?.isTTY ?? process.stderr.isTTY === true,
    progressIntervalMs: deps?.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
  };
}
