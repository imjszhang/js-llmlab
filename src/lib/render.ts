import type {
  BranchRecord,
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  DryRunEntry,
  SessionNode,
} from "../types.ts";

/** `--dry-run` 输出：纯 JSON，方便人和 agent 直接读。 */
export function renderDryRun(entries: DryRunEntry[]): string {
  return JSON.stringify({ dryRun: true, variants: entries }, null, 2);
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

export function renderTurn(node: SessionNode): string {
  const lines = [
    `# Turn ${node.id}`,
    "",
    `- parent: ${node.parentId ?? "null"}`,
    `- createdAt: ${node.createdAt}`,
    `- config: ${node.config.name}`,
    `- provider: ${node.config.provider ?? "null"}`,
    `- model: ${node.config.model}`,
    `- baseURL: ${node.config.baseURL}`,
    `- temperature: ${String(node.config.temperature)}`,
    `- maxTokens: ${String(node.config.maxTokens)}`,
    `- thinking: ${node.config.thinking ?? "null"}`,
    `- reasoningEffort: ${node.config.reasoningEffort ?? "null"}`,
    `- systemPreset: ${node.systemPreset ?? "null"}`,
    `- userPreset: ${node.userPreset ?? "null"}`,
    `- latencyMs: ${String(node.latencyMs)}`,
    `- error: ${node.error ?? "null"}`,
  ];
  if (node.usage !== null) {
    lines.push(
      `- promptTokens: ${String(node.usage.promptTokens)}`,
      `- completionTokens: ${String(node.usage.completionTokens)}`,
      `- totalTokens: ${String(node.usage.totalTokens)}`,
    );
    if (node.usage.reasoningTokens !== null) {
      lines.push(`- reasoningTokens: ${String(node.usage.reasoningTokens)}`);
    }
  }
  lines.push("", "## System", "", node.messages.system || "_(empty)_", "", "## User", "", node.messages.user);
  if (node.messages.reasoning !== null && node.messages.reasoning !== "") {
    lines.push("", "## Reasoning", "", node.messages.reasoning);
  }
  lines.push("", "## Assistant", "", node.messages.assistant || "_(empty)_", "");
  return lines.join("\n");
}

export function renderTree(nodes: SessionNode[], branches: BranchRecord[]): string {
  if (nodes.length === 0) {
    return "(空会话)";
  }
  const byParent = new Map<string | null, SessionNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const headLabels = new Map<string, string[]>();
  for (const branch of branches) {
    if (branch.head === null) {
      continue;
    }
    const labels = headLabels.get(branch.head) ?? [];
    labels.push(branch.name);
    headLabels.set(branch.head, labels);
  }

  const lines: string[] = [];
  const walk = (parentId: string | null, prefix: string, isLast: boolean): void => {
    const children = byParent.get(parentId) ?? [];
    children.forEach((node, index) => {
      const last = index === children.length - 1;
      const branch = parentId === null ? "" : isLast ? "    " : "│   ";
      const connector = parentId === null ? "" : last ? "└── " : "├── ";
      const labels = headLabels.get(node.id);
      const tag = labels !== undefined ? `  [${labels.join(", ")}]` : "";
      const preview = node.messages.user.replace(/\s+/gu, " ").slice(0, 48);
      const err = node.error !== null ? " !error" : "";
      lines.push(`${prefix}${connector}${node.id}  ${preview}${tag}${err}`);
      walk(node.id, `${prefix}${parentId === null ? "" : branch}`, last);
    });
  };
  walk(null, "", true);

  const branchLines = branches
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((branch) => `- ${branch.name}: ${branch.head ?? "(empty)"}`);
  return ["分支：", ...branchLines, "", "树：", ...lines].join("\n");
}

/** 表格单元格：去掉换行、转义竖线。 */
function cell(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/\|/gu, "\\|").trim();
}

function truncateCell(text: string, max = 60): string {
  const compact = cell(text);
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function intOrDash(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : String(Math.round(value));
}

/** 成稿 token：网关的 completion_tokens 含推理，能减就减掉。 */
export function answerTokens(variant: ComparisonVariant): number | null {
  if (variant.usage === null) {
    return null;
  }
  const { completionTokens, reasoningTokens } = variant.usage;
  if (reasoningTokens !== null && reasoningTokens <= completionTokens) {
    return completionTokens - reasoningTokens;
  }
  return completionTokens;
}

function ratio3(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : value.toFixed(3);
}

function percent1(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

/**
 * 每路一行、行序 = 输入顺序的汇总表；report.md 与终端共用。
 * 传了 `scores` 就追加「相似度 | 改动率」两列（按配置名对齐，缺的显示 `-`）。
 */
export function renderSummaryTable(
  variants: ComparisonVariant[],
  scores: ComparisonScores | null = null,
): string {
  const scoreByName = new Map(scores?.variants.map((s) => [s.configName, s]) ?? []);
  const header = [
    "| 配置 | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 错误 |",
    "|---|---|---|---|---:|---:|---:|---:|---|",
  ];
  if (scores !== null) {
    header[0] = `${header[0] ?? ""} 相似度 | 改动率 |`;
    header[1] = `${header[1] ?? ""}---:|---:|`;
  }
  const rows = variants.map((variant) => {
    const cells = [
      cell(variant.configName),
      cell(variant.config.model),
      variant.config.thinking ?? "-",
      variant.config.reasoningEffort ?? "-",
      seconds(variant.latencyMs),
      intOrDash(variant.usage?.reasoningTokens),
      intOrDash(answerTokens(variant)),
      intOrDash(variant.usage?.totalTokens),
      variant.error === null ? "-" : truncateCell(variant.error),
    ];
    if (scores !== null) {
      const score = scoreByName.get(variant.configName);
      cells.push(ratio3(score?.similarity), percent1(score?.changeRatio));
    }
    return `| ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

export function renderComparisonReport(
  spec: ComparisonSpec,
  variants: ComparisonVariant[],
  scores: ComparisonScores | null = null,
): string {
  const lines = [
    `# Comparison ${spec.id}`,
    "",
    `- createdAt: ${spec.createdAt}`,
    `- configs: ${spec.configs.join(", ")}`,
    `- systemPreset: ${spec.systemPreset ?? "null"}`,
    `- userPreset: ${spec.userPreset ?? "null"}`,
    `- session: ${spec.sessionId ?? "null"}`,
    `- from: ${spec.fromNodeId ?? "null"}`,
    "",
    "## 汇总",
    "",
    renderSummaryTable(variants, scores),
    "",
    "思维链在 `variants/<配置>/reasoning.md`。",
  ];
  if (scores !== null) {
    lines.push(
      `相似度 = 与参考答案（${scores.reference ?? "未提供"}）的字符级 LCS 比；改动率 = 相对${scores.baseline ?? "输入"}的改动比例；详见 \`scores.json\`。`,
    );
  }
  lines.push("", "## Input", "", spec.input, "");

  for (const variant of variants) {
    lines.push(`## ${variant.configName}`, "");
    if (variant.error !== null) {
      lines.push(`> error: ${variant.error}`, "");
    }
    lines.push(variant.assistant || "_(empty)_", "");
  }
  return lines.join("\n");
}

function variantHeader(title: string, variant: ComparisonVariant): string[] {
  return [
    `# ${title} ${variant.configName}`,
    "",
    `- provider: ${variant.config.provider ?? "null"}`,
    `- model: ${variant.config.model}`,
    `- baseURL: ${variant.config.baseURL}`,
    `- thinking: ${variant.config.thinking ?? "null"}`,
    `- reasoningEffort: ${variant.config.reasoningEffort ?? "null"}`,
    `- latencyMs: ${String(variant.latencyMs)}`,
    `- error: ${variant.error ?? "null"}`,
    `- nodeId: ${variant.nodeId ?? "null"}`,
    "",
  ];
}

/** `variants/<name>/output.md`：只有成稿。 */
export function renderVariantMarkdown(variant: ComparisonVariant): string {
  return [...variantHeader("Variant", variant), variant.assistant || "_(empty)_", ""].join("\n");
}

/** `variants/<name>/reasoning.md`：只有思维链。没有思维链时调用方不落盘。 */
export function renderVariantReasoning(variant: ComparisonVariant): string {
  return [...variantHeader("Reasoning", variant), variant.reasoning ?? "", ""].join("\n");
}

export function truncateTitle(text: string, max = 40): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= max) {
    return compact === "" ? "untitled" : compact;
  }
  return `${compact.slice(0, max - 1)}…`;
}

export function renderSessionSummary(
  title: string,
  createdAt: string,
  updatedAt: string,
  defaultConfig: string,
  defaultSystem: string | null,
): string {
  return [
    `title: ${yamlQuote(title)}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    `defaultConfig: ${defaultConfig}`,
    `defaultSystem: ${defaultSystem ?? "null"}`,
  ].join("\n");
}
