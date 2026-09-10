import chalk from "chalk";
import { describeNamedConfigs, loadEnv, peekConfigRef } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";

export function runConfigLs(): void {
  const root = findProjectRoot();
  loadEnv(root);
  const configs = describeNamedConfigs(root);
  if (configs.length === 0) {
    console.log("还没有命名配置。可在 configs/*.json 添加，或 --provider llmcore --config <model-id>。");
    return;
  }
  console.log(chalk.bold("命名配置（provider + 模型/参数）"));
  for (const item of configs) {
    const snap = item.snapshot;
    console.log(
      `${item.ref.padEnd(26)} ${(snap.provider ?? "-").padEnd(10)} model=${snap.model}  think=${snap.thinking ?? "-"}  effort=${snap.reasoningEffort ?? "-"}`,
    );
  }
}

export function runConfigShow(ref: string): void {
  const root = findProjectRoot();
  loadEnv(root);
  const peeked = peekConfigRef(root, ref);
  const snap = peeked.snapshot;
  console.log(chalk.bold(`配置 ${ref}`));
  console.log(`source: ${peeked.source === "file" ? "configs/" + ref + ".json" : "模型 id"}`);
  console.log(`provider: ${snap.provider ?? "null"}`);
  console.log(`name: ${snap.name}`);
  console.log(`baseURL: ${snap.baseURL}`);
  console.log(`model: ${snap.model}`);
  console.log(`temperature: ${String(snap.temperature)}`);
  console.log(`maxTokens: ${String(snap.maxTokens)}`);
  console.log(`thinking: ${snap.thinking ?? "null"}`);
  console.log(`reasoningEffort: ${snap.reasoningEffort ?? "null"}`);
  console.log(`apiKeyEnv: ${peeked.apiKeyEnv}`);
  console.log(`apiKey: ${peeked.apiKeyPresent ? "已设置" : "未设置"}`);
}
