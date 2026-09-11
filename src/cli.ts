import { Command } from "commander";
import { runBranchCreate, runBranchLs } from "./commands/branch.ts";
import { runChat } from "./commands/chat.ts";
import { runCompare } from "./commands/compare.ts";
import { runConfigLs, runConfigShow } from "./commands/config.ts";
import { runModels } from "./commands/models.ts";
import { runProviderLs, runProviderShow } from "./commands/provider.ts";
import { runCompareRetry, type RetryCliOptions } from "./commands/retry.ts";
import { runOnce } from "./commands/run.ts";
import { runCompareScore, type ScoreCliOptions } from "./commands/score.ts";
import { runSessionLs, runSessionShow } from "./commands/session.ts";
import { runCompareLs, runCompareShow, runNodeShow } from "./commands/show.ts";
import { runStatus } from "./commands/status.ts";
import { readPackageVersion } from "./lib/version.ts";
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
    .option("--reasoning-effort <level>", "low、high 或 max")
    .option("--timeout-ms <n>", "单次请求超时毫秒，缺省 600000")
    .option("--max-retries <n>", "失败重试次数，缺省 2");
}

type StringOptionKey = {
  [K in keyof SharedCliOptions]-?: SharedCliOptions[K] extends string | undefined ? K : never;
}[keyof SharedCliOptions];

function toShared(options: Record<string, unknown>): SharedCliOptions {
  const shared: SharedCliOptions = {};
  const assign = (key: StringOptionKey, value: unknown): void => {
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
  assign("timeoutMs", options.timeoutMs);
  assign("maxRetries", options.maxRetries);
  assign("from", options.from);
  assign("concurrency", options.concurrency);
  assign("repeat", options.repeat);
  if (typeof options.dryRun === "boolean") {
    shared.dryRun = options.dryRun;
  }
  return shared;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("js-llmlab")
    .description("OpenAI 兼容接口的本地提示词实验 CLI")
    .version(readPackageVersion());

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
      .option("--input <file>", "从文件读取用户输入")
      .option("--dry-run", "只打印解析后的配置与请求体，不发请求、不落盘"),
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

  const node = program.command("node").description("查看单个节点");
  node
    .command("show <session> <node>")
    .description("打印节点的 turn md；--json 打原始节点 JSON")
    .option("--json", "输出原始节点 JSON")
    .action((sessionId: string, nodeId: string, options: { json?: boolean }) => {
      runNodeShow(sessionId, nodeId, options.json === true ? { json: true } : {});
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

  const compare = addSharedOptions(
    program
      .command("compare")
      .description("同一输入、多配置或多模型对比；子命令 score 对已有对比打分")
      .option("--suite <name>", "预定义对比组，例如 deepseek")
      .option("--configs <names>", "逗号分隔的配置名或模型 id")
      .option("--models <ids>", "逗号分隔的模型 id，可与 --configs/--suite 并用")
      .option("--message <text>", "用户输入")
      .option("--input <file>", "从文件读取用户输入")
      .option("--from <node>", "从该节点继续")
      .option("--concurrency <n>", "并发路数，缺省 3")
      .option("--repeat <n>", "每路重复采样次数，缺省 1；> 1 时汇总表显示 均值 (最小–最大)")
      .option("--dry-run", "只打印解析后的配置与请求体，不发请求、不落盘"),
  ).action(async (options: Record<string, unknown>) => {
    await runCompare(toShared(options));
  });

  compare
    .command("ls")
    .description("按时间倒序列出所有对比")
    .action(() => {
      runCompareLs();
    });

  compare
    .command("show <comparison>")
    .description("打印一次对比的汇总表（与 report.md 相同）与目录")
    .action((comparison: string) => {
      runCompareShow(comparison);
    });

  compare
    .command("score <comparison>")
    .description("对已有对比算相似度与改动率，写 scores.json 并更新 report.md；不发请求")
    .option("--reference <file>", "参考答案文件；不给则相似度为 null")
    .option("--baseline <file>", "改动率的基线文件；缺省用对比的输入")
    .option("--judge <config>", "用该配置当 LLM 裁判逐路打 0–10 分（会发请求）")
    .option("--rubric <name>", "裁判 rubric，prompts/judge/<name>.md，缺省 default")
    .option("--concurrency <n>", "裁判并发路数，缺省 3")
    .action(async (comparison: string, options: Record<string, unknown>) => {
      const scoreOptions: ScoreCliOptions = {};
      for (const key of ["reference", "baseline", "judge", "rubric", "concurrency"] as const) {
        const value = options[key];
        if (typeof value === "string") {
          scoreOptions[key] = value;
        }
      }
      await runCompareScore(comparison, scoreOptions);
    });

  compare
    .command("retry <comparison>")
    .description("补跑已有对比里失败的路（或 --only 指定的路），更新 variant 与 report.md")
    .option("--only <names>", "逗号分隔的配置名，无论成败都重跑")
    .option("--concurrency <n>", "并发路数，缺省 3")
    .option("--timeout-ms <n>", "覆盖超时毫秒")
    .option("--max-retries <n>", "覆盖重试次数")
    .action(async (comparison: string, options: Record<string, unknown>) => {
      const retryOptions: RetryCliOptions = {};
      for (const key of ["only", "concurrency", "timeoutMs", "maxRetries"] as const) {
        const value = options[key];
        if (typeof value === "string") {
          retryOptions[key] = value;
        }
      }
      await runCompareRetry(comparison, retryOptions);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
