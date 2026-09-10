import chalk from "chalk";
import { listConfigs, loadEnv, maskSecret, peekConfig } from "../lib/config.ts";
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
  console.log(`${peeked.apiKeyEnv}：${maskSecret(key)}`);
  console.log(`OPENAI_BASE_URL：${process.env.OPENAI_BASE_URL ?? "(未设置，将用配置或默认)"}`);
  console.log(`OPENAI_MODEL：${process.env.OPENAI_MODEL ?? "(未设置，将用配置或默认)"}`);
  console.log("");
  console.log("默认解析结果（env → 默认值）：");
  console.log(`  name: ${peeked.snapshot.name}`);
  console.log(`  baseURL: ${peeked.snapshot.baseURL}`);
  console.log(`  model: ${peeked.snapshot.model}`);
  console.log(`  temperature: ${String(peeked.snapshot.temperature)}`);
  console.log(`  maxTokens: ${String(peeked.snapshot.maxTokens)}`);
  if (!peeked.apiKeyPresent) {
    console.log(chalk.yellow(`  警告：未设置 ${peeked.apiKeyEnv}，run/chat/compare 会失败。`));
  }
  console.log("");
  console.log(`命名配置：${listConfigs(root).join(", ") || "(无)"}`);
  console.log(`system 预设：${listPresets(root, "system").join(", ") || "(无)"}`);
  console.log(`user 预设：${listPresets(root, "user").join(", ") || "(无)"}`);
}
