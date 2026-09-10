import { Command } from "commander";
import { runBranchCreate, runBranchLs } from "./commands/branch.ts";
import { runChat } from "./commands/chat.ts";
import { runCompare } from "./commands/compare.ts";
import { runOnce } from "./commands/run.ts";
import { runSessionLs, runSessionShow } from "./commands/session.ts";
import { runStatus } from "./commands/status.ts";
import type { SharedCliOptions } from "./types.ts";

function addSharedOptions(command: Command): Command {
  return command
    .option("--session <id>", "已有会话 id")
    .option("--branch <name>", "分支名", "main")
    .option("--config <name>", "命名配置")
    .option("--system <name>", "system 预设")
    .option("--user <name>", "user 预设")
    .option("--model <name>", "覆盖模型")
    .option("--temperature <n>", "覆盖温度")
    .option("--max-tokens <n>", "覆盖 maxTokens");
}

function toShared(options: Record<string, unknown>): SharedCliOptions {
  const shared: SharedCliOptions = {};
  const assign = (key: keyof SharedCliOptions, value: unknown): void => {
    if (typeof value === "string") {
      shared[key] = value;
    }
  };
  assign("session", options.session);
  assign("branch", options.branch);
  assign("config", options.config);
  assign("system", options.system);
  assign("user", options.user);
  assign("message", options.message);
  assign("input", options.input);
  assign("model", options.model);
  assign("temperature", options.temperature);
  assign("maxTokens", options.maxTokens);
  assign("from", options.from);
  return shared;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("js-llmlab")
    .description("OpenAI 兼容接口的本地提示词实验 CLI")
    .version("0.1.0");

  program.command("status").description("查看环境、配置和预设").action(() => {
    runStatus();
  });

  addSharedOptions(program.command("chat").description("交互式对话")).action(
    async (options: Record<string, unknown>) => {
      await runChat(toShared(options));
    },
  );

  addSharedOptions(
    program
      .command("run")
      .description("非交互跑一轮")
      .option("--message <text>", "用户输入")
      .option("--input <file>", "从文件读取用户输入"),
  ).action(async (options: Record<string, unknown>) => {
    await runOnce(toShared(options));
  });

  const session = program.command("session").description("查看会话");
  session.command("ls").description("列出会话").action(() => {
    runSessionLs();
  });
  session.command("show").argument("<id>", "会话 id").description("查看会话树").action((id: string) => {
    runSessionShow(id);
  });

  const branch = program.command("branch").description("管理分支");
  branch
    .command("ls")
    .requiredOption("--session <id>", "会话 id")
    .description("列出分支")
    .action((options: { session: string }) => {
      runBranchLs(options.session);
    });
  branch
    .command("create")
    .requiredOption("--session <id>", "会话 id")
    .requiredOption("--name <name>", "新分支名")
    .option("--from <node>", "从该节点 fork")
    .description("从节点创建分支")
    .action((options: { session: string; name: string; from?: string }) => {
      const args: { session: string; name: string; from?: string } = {
        session: options.session,
        name: options.name,
      };
      if (options.from !== undefined) {
        args.from = options.from;
      }
      runBranchCreate(args);
    });

  addSharedOptions(
    program
      .command("compare")
      .description("同一输入、多配置对比")
      .requiredOption("--configs <names>", "逗号分隔的配置名")
      .option("--message <text>", "用户输入")
      .option("--input <file>", "从文件读取用户输入")
      .option("--from <node>", "从该节点继续"),
  ).action(async (options: Record<string, unknown>) => {
    const shared = toShared(options);
    await runCompare({
      ...shared,
      ...(typeof options.configs === "string" ? { configs: options.configs } : {}),
    });
  });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
