import type {
  ComparisonSpec,
  ComparisonVariant,
  JudgeInfo,
  JudgeVerdict,
  ResolvedConfig,
} from "../types.ts";
import type { Completer } from "./client.ts";
import { safeVariantName, toSnapshot } from "./config.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import type { LabStore } from "./store.ts";
import { appendTurn, forkBranch } from "./tree.ts";

/** 裁判轮的 system；rubric 本身是 user 消息，放 prompts/judge/<name>.md。 */
export const JUDGE_SYSTEM = "你是评审。严格按要求只输出一个 JSON 对象，不要输出其他内容。";

export function renderJudgePrompt(
  template: string,
  vars: { input: string; reference: string | null; candidate: string },
): string {
  return template
    .replaceAll("{{input}}", vars.input)
    .replaceAll("{{reference}}", vars.reference ?? "（未提供参考答案）")
    .replaceAll("{{candidate}}", vars.candidate);
}

function checkScore(value: unknown): number {
  const score = typeof value === "string" ? Number(value) : value;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`裁判 score 不在 0–10：${String(value)}`);
  }
  return score;
}

/**
 * JSON 不合法时的兜底：直接抠 `"score": n` 与 `"reason": "…"`。
 * 真实案例：模型把 reason 的收尾引号写成了中文 `”`。
 */
function salvageJudgeReply(body: string): { score: number; reason: string } | null {
  const scoreMatch = /"score"\s*:\s*"?(\d+(?:\.\d+)?)"?/u.exec(body);
  if (scoreMatch === null) {
    return null;
  }
  // reason 取到结尾：去掉收尾的 } 与两侧任意一种引号，中间的引号原样保留
  const reasonKey = /"reason"\s*:\s*/u.exec(body);
  let reason = "";
  if (reasonKey !== null) {
    reason = body
      .slice(reasonKey.index + reasonKey[0].length)
      .replace(/\s*\}\s*$/u, "")
      .trim()
      .replace(/^["“]/u, "")
      .replace(/["”]$/u, "")
      .trim();
  }
  return { score: checkScore(scoreMatch[1]), reason };
}

/** 从裁判回复里抠出 `{ score, reason }`；容忍代码围栏、前后废话与常见的引号错误。 */
export function parseJudgeReply(text: string): { score: number; reason: string } {
  const stripped = text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/u, "")
    .replace(/\s*```$/u, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("裁判输出里没有 JSON 对象");
  }
  const body = stripped.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const salvaged = salvageJudgeReply(body);
    if (salvaged === null) {
      throw new Error("裁判输出的 JSON 解析失败");
    }
    return salvaged;
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("裁判输出不是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  return {
    score: checkScore(record.score),
    reason: typeof record.reason === "string" ? record.reason : "",
  };
}

/**
 * 用一路配置当裁判，给每路候选打分。每次裁判调用都落到一个新会话
 * （标题 `judge: <c_id>`，每路一个分支），方便事后翻思维链。
 */
export async function judgeComparison(params: {
  store: LabStore;
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
  referenceText: string | null;
  rubricName: string;
  rubricTemplate: string;
  config: ResolvedConfig;
  complete: Completer;
  concurrency: number;
  log: (line: string) => void;
}): Promise<{ info: JudgeInfo; verdicts: Map<string, JudgeVerdict> }> {
  const { store, spec, variants, config, complete, log } = params;
  const session = store.createSession({
    title: `judge: ${spec.id}`,
    defaultConfig: config.name,
    defaultSystem: null,
  });
  const info: JudgeInfo = {
    config: toSnapshot(config),
    rubric: params.rubricName,
    sessionId: session.id,
  };

  const results = await mapWithConcurrency(variants, params.concurrency, async (variant) => {
    if (variant.error !== null || variant.assistant.trim() === "") {
      const verdict: JudgeVerdict = {
        score: null,
        reason: null,
        error: variant.error !== null ? `候选路失败，未评审：${variant.error}` : "候选为空，未评审",
        nodeId: null,
        usage: null,
        latencyMs: 0,
      };
      return [variant.configName, verdict] as const;
    }

    const branchName = `judge-${safeVariantName(variant.configName)}`;
    forkBranch(store, session.id, branchName, null);
    log(`裁判 ${variant.configName}…`);
    const node = await appendTurn({
      store,
      sessionId: session.id,
      branchName,
      parentId: null,
      config,
      systemText: JUDGE_SYSTEM,
      systemPreset: null,
      userPreset: `judge/${params.rubricName}`,
      userText: renderJudgePrompt(params.rubricTemplate, {
        input: spec.input,
        reference: params.referenceText,
        candidate: variant.assistant,
      }),
      complete,
      touchSession: false,
    });

    let verdict: JudgeVerdict;
    if (node.error !== null) {
      verdict = { score: null, reason: null, error: node.error, nodeId: node.id, usage: node.usage, latencyMs: node.latencyMs };
    } else {
      try {
        const parsed = parseJudgeReply(node.messages.assistant);
        verdict = { score: parsed.score, reason: parsed.reason, error: null, nodeId: node.id, usage: node.usage, latencyMs: node.latencyMs };
      } catch (error) {
        verdict = {
          score: null,
          reason: null,
          error: error instanceof Error ? error.message : String(error),
          nodeId: node.id,
          usage: node.usage,
          latencyMs: node.latencyMs,
        };
      }
    }
    log(
      verdict.error === null
        ? `裁判 ${variant.configName} → ${String(verdict.score)}`
        : `裁判 ${variant.configName} 失败：${verdict.error}`,
    );
    return [variant.configName, verdict] as const;
  });
  store.touchSession(session.id);

  return { info, verdicts: new Map(results) };
}
