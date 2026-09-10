import type {
  BranchRecord,
  ComparisonSpec,
  ComparisonVariant,
  SessionNode,
} from "../types.ts";

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

export function renderComparisonReport(
  spec: ComparisonSpec,
  variants: ComparisonVariant[],
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
    "## Input",
    "",
    spec.input,
    "",
  ];

  for (const variant of variants) {
    lines.push(
      `## ${variant.configName}`,
      "",
      `- provider: ${variant.config.provider ?? "null"}`,
      `- model: ${variant.config.model}`,
      `- baseURL: ${variant.config.baseURL}`,
      `- temperature: ${String(variant.config.temperature)}`,
      `- maxTokens: ${String(variant.config.maxTokens)}`,
      `- thinking: ${variant.config.thinking ?? "null"}`,
      `- reasoningEffort: ${variant.config.reasoningEffort ?? "null"}`,
      `- latencyMs: ${String(variant.latencyMs)}`,
      `- error: ${variant.error ?? "null"}`,
      `- nodeId: ${variant.nodeId ?? "null"}`,
    );
    if (variant.usage !== null) {
      lines.push(
        `- promptTokens: ${String(variant.usage.promptTokens)}`,
        `- completionTokens: ${String(variant.usage.completionTokens)}`,
        `- totalTokens: ${String(variant.usage.totalTokens)}`,
      );
      if (variant.usage.reasoningTokens !== null) {
        lines.push(`- reasoningTokens: ${String(variant.usage.reasoningTokens)}`);
      }
    }
    if (variant.reasoning !== null && variant.reasoning !== "") {
      lines.push("", "### Reasoning", "", variant.reasoning);
    }
    lines.push("", variant.assistant || "_(empty)_", "");
  }
  return lines.join("\n");
}

export function renderVariantMarkdown(variant: ComparisonVariant): string {
  return [
    `# Variant ${variant.configName}`,
    "",
    `- provider: ${variant.config.provider ?? "null"}`,
    `- model: ${variant.config.model}`,
    `- baseURL: ${variant.config.baseURL}`,
    `- error: ${variant.error ?? "null"}`,
    "",
    ...(variant.reasoning !== null && variant.reasoning !== ""
      ? ["### Reasoning", "", variant.reasoning, ""]
      : []),
    variant.assistant || "_(empty)_",
    "",
  ].join("\n");
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
