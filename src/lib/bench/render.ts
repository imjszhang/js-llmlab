import type { BenchRunRecord, BenchSpec } from "./types.ts";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
}

function nativeAccountLabel(target: BenchRunRecord["target"]): string | null {
  if (target.kind !== "harness") return null;
  if (target.backend.auth === "chatgpt") return "ChatGPT 订阅";
  if (target.backend.auth === "claude-subscription") return "Claude 订阅";
  if (target.backend.auth === "cursor-login") return "Cursor 账号";
  if (target.backend.auth === "cursor-api-key") return "Cursor 用户 API key";
  return null;
}

export function renderBenchSummary(records: readonly BenchRunRecord[]): string {
  const lines = [
    "| target | 次数 | 类型 / provider | 模型 | 执行 | 验收 | 耗时 s | token | 成本 | 改动文件 |",
    "| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: |",
  ];
  for (const { target, sample, execution, grade, changes } of records) {
    const nativeAccount = nativeAccountLabel(target);
    const cursorService = target.kind === "harness" && (target.backend.auth === "cursor-login" || target.backend.auth === "cursor-api-key");
    const provider = target.kind === "llm" ? target.config.provider ?? "default" : nativeAccount ?? target.backend.provider ?? "未知";
    const model = target.kind === "llm" ? target.config.model : target.backend.model;
    const cost = cursorService ? "未知（Cursor 服务）" : nativeAccount ? "未知（订阅）" : execution.cost === null ? "-" : `${execution.cost.total.toFixed(6)} ${cell(execution.cost.currency)}`;
    lines.push(`| ${cell(target.name)} | ${String(sample)} | ${target.kind} / ${cell(provider)} | ${cell(model)} | ${execution.status} | ${grade.status} | ${(execution.latencyMs / 1000).toFixed(2)} | ${cursorService || execution.usage === null ? "-" : String(execution.usage.totalTokens)} | ${cost} | ${String(changes.length)} |`);
  }
  return lines.join("\n");
}

export function renderBenchReport(spec: BenchSpec, records: readonly BenchRunRecord[]): string {
  const lines = [
    `# Benchmark ${spec.id}`, "", `任务：${spec.task.name}  创建时间：${spec.createdAt}`,
    ``, `Fixture SHA-256：\`${spec.fixture.hash}\`；每路 ${String(spec.repeat)} 次；并发 ${String(spec.concurrency)}。`, "",
    renderBenchSummary(records), "",
    "执行完成只表示 adapter 收到成功终态；任务是否完成看验收列。缺失 token / 成本显示为 -。", "",
    "## 输入", "", spec.task.prompt, "", "## 采样", "",
  ];
  for (const record of records) {
    const { target, execution, grade } = record;
    const relative = `variants/${target.name}/run-${String(record.sample)}`;
    const nativeAccount = nativeAccountLabel(target);
    const cursorService = target.kind === "harness" && (target.backend.auth === "cursor-login" || target.backend.auth === "cursor-api-key");
    lines.push(`### ${target.name} / ${String(record.sample)}`, "");
    if (target.kind === "harness") {
      const route = target.profile.adapter === "cursor-agent" ? "cursor-agent" : nativeAccount ?? target.backend.protocol;
      lines.push(`Harness：${target.profile.adapter}；版本：${execution.harnessVersion ?? "未知"}；路由：${route}；权限：${target.profile.permission}。`, "");
    }
    const costSource = nativeAccount ? `${nativeAccount}，单次实际费用未知` : execution.costSource ?? "未知";
    const usageSource = cursorService ? "未知（完整 token 用量未验证）" : execution.usageSource ?? "未知";
    lines.push(`执行：${execution.status}；验收：${grade.status}；usage 来源：${usageSource}；成本来源：${costSource}。`, "");
    if (execution.error !== null) lines.push(`错误：${cell(execution.error)}`, "");
    for (const check of grade.checks) lines.push(`- ${check.passed ? "通过" : "失败"} ${check.check.kind}：${cell(check.detail)}`);
    lines.push("", `[成稿](${relative}/output.md) · [完整记录](${relative}/record.json) · [事件](${relative}/events.jsonl) · [文件改动](${relative}/changes.json)`, "");
  }
  return `${lines.join("\n")}\n`;
}
