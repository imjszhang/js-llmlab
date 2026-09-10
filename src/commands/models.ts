import chalk from "chalk";
import { listProviderModels } from "../lib/client.ts";
import { hasNamedConfig, loadEnv, overridesFromCli, resolveConfig } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";
import type { SharedCliOptions } from "../types.ts";

export async function runModels(options: SharedCliOptions = {}): Promise<void> {
  const root = findProjectRoot();
  loadEnv(root);
  const config = resolveConfig(root, undefined, overridesFromCli(options));
  const models = await listProviderModels(config);
  const current = config.model;

  console.log(chalk.bold(`provider ${config.provider ?? "env"}（${config.baseURL}）`));
  console.log(chalk.dim(`${String(models.length)} 个 · 默认模型 ${current}`));
  console.log("");
  for (const model of models) {
    const mark = model.id === current ? "*" : " ";
    const file = hasNamedConfig(root, model.id) ? "  [config]" : "";
    const owner = model.ownedBy !== null ? chalk.dim(`  ${model.ownedBy}`) : "";
    console.log(`${mark} ${model.id}${file}${owner}`);
  }
  console.log("");
  console.log(chalk.dim("主测：js-llmlab compare --suite deepseek --message '...'"));
  console.log(chalk.dim("指定网关：js-llmlab models --provider llmcore"));
}
