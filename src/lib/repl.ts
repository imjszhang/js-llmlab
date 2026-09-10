import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { LabStore } from "./store.ts";
import { listPresets } from "./presets.ts";
import { listConfigs } from "./config.ts";
import { forkBranch } from "./tree.ts";
import { renderTree } from "./render.ts";

export type ReplState = {
  sessionId: string;
  branchName: string;
  configName: string;
  systemName: string | null;
  userName: string | null;
};

export type ReplCommandResult =
  | { kind: "continue" }
  | { kind: "exit" }
  | { kind: "message"; text: string };

export function createReadline(): readline.Interface {
  return readline.createInterface({ input, output, terminal: true });
}

export function formatPrompt(state: ReplState): string {
  const system = state.systemName ?? "-";
  const user = state.userName ?? "-";
  return `${chalk.cyan("js-llmlab")} ${chalk.dim(state.sessionId)} ${chalk.yellow(state.branchName)} ${chalk.dim(`[${state.configName}/${system}/${user}]`)} > `;
}

export function helpText(): string {
  return [
    "斜杠命令：",
    "  /help                 显示帮助",
    "  /system [name]        查看或切换 system 预设",
    "  /user [name|clear]    查看、切换或清除 user 预设",
    "  /config [name]        查看或切换命名配置",
    "  /branch [name]        切换已有分支；不存在则从当前 head fork",
    "  /branches             列出分支",
    "  /tree                 显示会话树",
    "  /exit                 退出",
    "空行忽略。其余输入作为本轮 user 消息。",
  ].join("\n");
}

export function parseReplLine(line: string): ReplCommandResult {
  const trimmed = line.trim();
  if (trimmed === "") {
    return { kind: "continue" };
  }
  if (!trimmed.startsWith("/")) {
    return { kind: "message", text: line };
  }
  const [command = "", ...rest] = trimmed.slice(1).split(/\s+/u);
  if (command === "exit" || command === "quit") {
    return { kind: "exit" };
  }
  return { kind: "message", text: `/${command} ${rest.join(" ")}`.trimEnd() };
}

export async function handleSlashCommand(params: {
  root: string;
  store: LabStore;
  state: ReplState;
  line: string;
}): Promise<"exit" | "handled" | "not-command"> {
  const trimmed = params.line.trim();
  if (!trimmed.startsWith("/")) {
    return "not-command";
  }
  const [command = "", ...rest] = trimmed.slice(1).split(/\s+/u);
  const arg = rest.join(" ").trim();
  const { root, store, state } = params;

  switch (command) {
    case "help":
      console.log(helpText());
      return "handled";
    case "exit":
    case "quit":
      return "exit";
    case "system": {
      if (arg === "") {
        console.log(`当前 system：${state.systemName ?? "(无)"}`);
        console.log(`可用：${listPresets(root, "system").join(", ") || "(无)"}`);
        return "handled";
      }
      if (!listPresets(root, "system").includes(arg)) {
        console.log(chalk.red(`找不到 system 预设：${arg}`));
        return "handled";
      }
      state.systemName = arg;
      console.log(`已切换 system：${arg}`);
      return "handled";
    }
    case "user": {
      if (arg === "" || arg === "clear") {
        if (arg === "clear") {
          state.userName = null;
          console.log("已清除 user 预设");
          return "handled";
        }
        console.log(`当前 user：${state.userName ?? "(无)"}`);
        console.log(`可用：${listPresets(root, "user").join(", ") || "(无)"}`);
        return "handled";
      }
      if (!listPresets(root, "user").includes(arg)) {
        console.log(chalk.red(`找不到 user 预设：${arg}`));
        return "handled";
      }
      state.userName = arg;
      console.log(`已切换 user：${arg}`);
      return "handled";
    }
    case "config": {
      if (arg === "") {
        console.log(`当前配置：${state.configName}`);
        console.log(`可用：${listConfigs(root).join(", ") || "(无)"}`);
        return "handled";
      }
      if (!listConfigs(root).includes(arg)) {
        console.log(chalk.red(`找不到配置：${arg}`));
        return "handled";
      }
      state.configName = arg;
      console.log(`已切换配置：${arg}`);
      return "handled";
    }
    case "branches": {
      const branches = store.listBranches(state.sessionId);
      for (const branch of branches) {
        const mark = branch.name === state.branchName ? "*" : " ";
        console.log(`${mark} ${branch.name}  head=${branch.head ?? "(empty)"}`);
      }
      return "handled";
    }
    case "tree": {
      console.log(renderTree(store.listNodes(state.sessionId), store.listBranches(state.sessionId)));
      return "handled";
    }
    case "branch": {
      if (arg === "") {
        console.log(`当前分支：${state.branchName}`);
        return "handled";
      }
      if (store.branchExists(state.sessionId, arg)) {
        state.branchName = arg;
        console.log(`已切换分支：${arg}`);
        return "handled";
      }
      const current = store.getBranch(state.sessionId, state.branchName);
      forkBranch(store, state.sessionId, arg, current.head);
      state.branchName = arg;
      console.log(`已从 ${current.head ?? "(root)"} 创建并切换到分支：${arg}`);
      return "handled";
    }
    default:
      console.log(chalk.red(`未知命令：/${command}（/help 查看帮助）`));
      return "handled";
  }
}
