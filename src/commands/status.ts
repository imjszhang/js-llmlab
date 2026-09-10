import chalk from "chalk";
import {
  describeNamedConfigs,
  describeProviders,
  loadEnv,
  maskSecret,
  peekConfig,
} from "../lib/config.ts";
import { findProjectRoot, getDataDir } from "../lib/paths.ts";
import { listPresets } from "../lib/presets.ts";

export function runStatus(): void {
  const root = findProjectRoot();
  loadEnv(root);
  const peeked = peekConfig(root);
  const key = process.env[peeked.apiKeyEnv];

  console.log(chalk.bold("js-llmlab 状态"));
  console.log(`项目根：${root}`);
  console.log(`数据目录：${getDataDir(root)}`);
  console.log(`默认 provider：${peeked.snapshot.provider ?? "(env)"}`);
  console.log(`${peeked.apiKeyEnv}：${maskSecret(key)}`);
  console.log(`baseURL：${peeked.snapshot.baseURL}`);
  console.log(`model：${peeked.snapshot.model}`);
  if (!peeked.apiKeyPresent) {
    console.log(chalk.yellow(`  警告：未设置 ${peeked.apiKeyEnv}，run/chat/compare 会失败。`));
  }
  console.log("");
  console.log(chalk.bold("Providers"));
  const providers = describeProviders(root);
  if (providers.length === 0) {
    console.log("  (无)");
  } else {
    for (const item of providers) {
      const name = item.snapshot.provider ?? item.snapshot.name;
      console.log(
        `  ${name}  ${item.apiKeyEnv}=${item.apiKeyPresent ? "已设置" : "未设置"}  ${item.snapshot.baseURL}`,
      );
    }
  }
  console.log("");
  console.log(chalk.bold("命名配置"));
  const named = describeNamedConfigs(root);
  if (named.length === 0) {
    console.log("  (无)");
  } else {
    for (const item of named) {
      console.log(
        `  ${item.ref}  →  ${item.snapshot.provider ?? "-"} / ${item.snapshot.model}  temp=${String(item.snapshot.temperature)}`,
      );
    }
  }
  console.log("");
  console.log(`system 预设：${listPresets(root, "system").join(", ") || "(无)"}`);
  console.log(`user 预设：${listPresets(root, "user").join(", ") || "(无)"}`);
}
