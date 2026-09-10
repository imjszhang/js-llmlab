import { Command } from "commander";
import { runBranchCreate, runBranchLs } from "./commands/branch.ts";
import { runChat } from "./commands/chat.ts";
import { runCompare } from "./commands/compare.ts";
import { runConfigLs, runConfigShow } from "./commands/config.ts";
import { runModels } from "./commands/models.ts";
import { runProviderLs, runProviderShow } from "./commands/provider.ts";
import { runOnce } from "./commands/run.ts";
import { runSessionLs, runSessionShow } from "./commands/session.ts";
import { runStatus } from "./commands/status.ts";
import type { SharedCliOptions } from "./types.ts";

function addSharedOptions(command: Command): Command {
  return command
    .option("--session <id>", "已有会话 id")
    .option("--branch <name>", "分支名", "main")
    .option("--config <name>", "命名配置或模型 id")
    .option("--provider <name>", "provider，例如 llmcore")
    .option("--system <name>", "system 预设")
    .option("--user <name>", "user 预设")
    .option("--model <name>", "覆盖模型")
    .option("--temperature <n>", "覆盖温度")
    .option("--max-tokens <n>", "覆盖 maxTokens")
    .option("--thinking <mode>", "enabled 或 disabled")
    .option("--reasoning-effort <level>", "low、high 或 max");
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
  assign("models", options.models);
  assign("configs", options.configs);
  assign("provider", options.provider);
  assign("suite", options.suite);
  assign("temperature", options.temperature);
  assign("maxTokens", options.maxTokens);
  assign("thinking", options.thinking);
  assign("reasoningEffort", options.reasoningEffort);
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

  program
    .command("models")
    .description("列出 provider 支持的模型")
    .option("--provider <name>", "provider，例如 llmcore")
    .action(async (options: Record<string, unknown>) => {
      await runModels(toShared(options));
    });

  const providerCmd = program.command("provider").description("查看 provider");
  providerCmd.command("ls").description("列出 provider").action(() => {
    runProviderLs();
  });
  providerCmd
    .command("show")
    .argument("<name>", "provider 名")
    .description("查看一套 provider")
    .action((name: string) => {
      runProviderShow(name);
    });

  const configCmd = program.command("config").description("查看命名配置");
  configCmd.command("ls").description("列出命名配置及解析结果").action(() => {
    runConfigLs();
  });
  configCmd
    .command("show")
    .argument("<name>", "配置名或模型 id")
    .description("查看一套配置的解析结果")
    .action((name: string) => {
      runConfigShow(name);
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
      .description("同一输入、多配置或多模型对比")
      .option("--suite <name>", "预定义对比组，例如 deepseek")
      .option("--configs <names>", "逗号分隔的配置名或模型 id")
      .option("--models <ids>", "逗号分隔的模型 id，可与 --configs/--suite 并用")
      .option("--message <text>", "用户输入")
      .option("--input <file>", "从文件读取用户输入")
      .option("--from <node>", "从该节点继续"),
  ).action(async (options: Record<string, unknown>) => {
    await runCompare(toShared(options));
  });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
