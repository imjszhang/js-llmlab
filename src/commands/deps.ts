import { runCompletion, type Completer } from "../lib/client.ts";
import { findProjectRoot } from "../lib/paths.ts";

/**
 * 命令层可注入的依赖。CLI 入口不传，全部取默认；测试传临时根目录、
 * 假 completer 和静默日志，让编排逻辑离线跑。
 */
export type CommandDeps = {
  root?: string;
  complete?: Completer;
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
  return {
    root: deps?.root ?? findProjectRoot(),
    complete: deps?.complete ?? runCompletion,
    log: deps?.log ?? ((line: string): void => {
      console.log(line);
    }),
    error: deps?.error ?? ((line: string): void => {
      console.error(line);
    }),
  };
}
