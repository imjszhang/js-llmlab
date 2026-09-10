import chalk from "chalk";
import { describeProviders, loadEnv, maskSecret, peekConfig } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";

export function runProviderLs(): void {
  const root = findProjectRoot();
  loadEnv(root);
  const providers = describeProviders(root);
  if (providers.length === 0) {
    console.log("还没有 provider。在 providers/*.json 添加，例如 providers/llmcore.json。");
    return;
  }
  console.log(chalk.bold("Providers"));
  for (const item of providers) {
    const snap = item.snapshot;
    const key = process.env[item.apiKeyEnv];
    console.log(
      `${(snap.provider ?? snap.name).padEnd(16)} model=${snap.model}  ${item.apiKeyEnv}=${maskSecret(key)}  ${snap.baseURL}`,
    );
  }
}

export function runProviderShow(name: string): void {
  const root = findProjectRoot();
  loadEnv(root);
  const peeked = peekConfig(root, undefined, { provider: name });
  const snap = peeked.snapshot;
  console.log(chalk.bold(`provider ${name}`));
  console.log(`baseURL: ${snap.baseURL}`);
  console.log(`model: ${snap.model}`);
  console.log(`temperature: ${String(snap.temperature)}`);
  console.log(`maxTokens: ${String(snap.maxTokens)}`);
  console.log(`apiKeyEnv: ${peeked.apiKeyEnv}`);
  console.log(`apiKey: ${peeked.apiKeyPresent ? "已设置" : "未设置"}`);
}
