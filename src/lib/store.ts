import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  BranchRecord,
  ComparisonScores,
  ComparisonSpec,
  ComparisonVariant,
  RawCapture,
  SessionMeta,
  SessionNode,
  VariantRun,
} from "../types.ts";
import { redactSecrets } from "./client.ts";
import { safeVariantName } from "./config.ts";
import { createId } from "./ids.ts";
import {
  isRecord,
  parseComparisonScores,
  parseComparisonSpec,
  parseConfigSnapshot,
  parseSessionNode,
  requireNullableString,
  requireString,
} from "./parse.ts";
import {
  comparisonDir,
  getComparisonsDir,
  getSessionsDir,
  sessionDir,
} from "./paths.ts";
import { renderTurn, renderVariantMarkdown, renderVariantReasoning, renderVariantRun } from "./render.ts";
import { runFromNode, variantFromRuns } from "./runs.ts";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export type StoredComparison = {
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
  dir: string;
};

export class LabStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  ensureLayout(): void {
    mkdirSync(getSessionsDir(this.root), { recursive: true });
    mkdirSync(getComparisonsDir(this.root), { recursive: true });
  }

  createSession(input: {
    title: string;
    defaultConfig: string;
    defaultSystem: string | null;
    id?: string;
  }): SessionMeta {
    this.ensureLayout();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: input.id ?? createId("s"),
      title: input.title,
      createdAt: now,
      updatedAt: now,
      defaultConfig: input.defaultConfig,
      defaultSystem: input.defaultSystem,
    };
    const dir = sessionDir(this.root, meta.id);
    mkdirSync(path.join(dir, "nodes"), { recursive: true });
    mkdirSync(path.join(dir, "turns"), { recursive: true });
    mkdirSync(path.join(dir, "branches"), { recursive: true });
    writeJson(path.join(dir, "meta.json"), meta);
    this.writeBranch(meta.id, {
      name: "main",
      head: null,
      createdFrom: null,
    });
    return meta;
  }

  sessionExists(sessionId: string): boolean {
    return existsSync(path.join(sessionDir(this.root, sessionId), "meta.json"));
  }

  getSession(sessionId: string): SessionMeta {
    const filePath = path.join(sessionDir(this.root, sessionId), "meta.json");
    if (!existsSync(filePath)) {
      throw new Error(`找不到会话：${sessionId}`);
    }
    return this.parseSessionMeta(readJson(filePath));
  }

  updateSession(sessionId: string, patch: Partial<Pick<SessionMeta, "title" | "defaultConfig" | "defaultSystem">>): SessionMeta {
    const current = this.getSession(sessionId);
    const next: SessionMeta = {
      ...current,
      updatedAt: new Date().toISOString(),
    };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.defaultConfig !== undefined) next.defaultConfig = patch.defaultConfig;
    if (patch.defaultSystem !== undefined) next.defaultSystem = patch.defaultSystem;
    writeJson(path.join(sessionDir(this.root, sessionId), "meta.json"), next);
    return next;
  }

  listSessions(): SessionMeta[] {
    this.ensureLayout();
    const dir = getSessionsDir(this.root);
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((id) => existsSync(path.join(dir, id, "meta.json")))
      .map((id) => this.getSession(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * 写节点 JSON 与 turn md。缺省顺手刷一次会话 `updatedAt`；
   * 并发跑多路时传 `touchSession: false`，整轮结束后调一次 `touchSession`。
   */
  writeNode(sessionId: string, node: SessionNode, options: { touchSession?: boolean } = {}): void {
    const dir = sessionDir(this.root, sessionId);
    writeJson(path.join(dir, "nodes", `${node.id}.json`), node);
    writeFileSync(path.join(dir, "turns", `${node.id}.md`), renderTurn(node), "utf8");
    if (options.touchSession !== false) {
      this.touchSession(sessionId);
    }
  }

  /** 只刷会话的 `updatedAt`。 */
  touchSession(sessionId: string): void {
    this.updateSession(sessionId, {});
  }

  nodeExists(sessionId: string, nodeId: string): boolean {
    return existsSync(path.join(sessionDir(this.root, sessionId), "nodes", `${nodeId}.json`));
  }

  /**
   * 写 `nodes/<id>.raw.json`：原始请求 / 响应 / 错误。`secrets` 里的字符串
   * （当前 apiKey）若出现在序列化结果里会整体替换成 `***`，作为不泄密的最后兜底。
   */
  writeNodeRaw(sessionId: string, nodeId: string, raw: RawCapture, secrets: string[] = []): string {
    const filePath = this.nodeRawPath(sessionId, nodeId);
    const text = redactSecrets(
      JSON.stringify({ nodeId, capturedAt: new Date().toISOString(), ...raw }, null, 2),
      secrets,
    );
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${text}\n`, "utf8");
    return filePath;
  }

  nodeRawPath(sessionId: string, nodeId: string): string {
    return path.join(sessionDir(this.root, sessionId), "nodes", `${nodeId}.raw.json`);
  }

  /** 读 raw 文件；老节点没有就 null。 */
  readNodeRaw(sessionId: string, nodeId: string): unknown {
    const filePath = this.nodeRawPath(sessionId, nodeId);
    return existsSync(filePath) ? readJson(filePath) : null;
  }

  getNode(sessionId: string, nodeId: string): SessionNode {
    const filePath = path.join(sessionDir(this.root, sessionId), "nodes", `${nodeId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`找不到节点：${sessionId}/${nodeId}`);
    }
    return parseSessionNode(readJson(filePath));
  }

  listNodes(sessionId: string): SessionNode[] {
    const dir = path.join(sessionDir(this.root, sessionId), "nodes");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json") && !file.endsWith(".raw.json"))
      .map((file) => parseSessionNode(readJson(path.join(dir, file))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  writeBranch(sessionId: string, branch: BranchRecord): void {
    writeJson(
      path.join(sessionDir(this.root, sessionId), "branches", `${branch.name}.json`),
      branch,
    );
  }

  getBranch(sessionId: string, name: string): BranchRecord {
    const filePath = path.join(sessionDir(this.root, sessionId), "branches", `${name}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`找不到分支：${sessionId}/${name}`);
    }
    return this.parseBranch(readJson(filePath));
  }

  branchExists(sessionId: string, name: string): boolean {
    return existsSync(path.join(sessionDir(this.root, sessionId), "branches", `${name}.json`));
  }

  listBranches(sessionId: string): BranchRecord[] {
    const dir = path.join(sessionDir(this.root, sessionId), "branches");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.parseBranch(readJson(path.join(dir, file))))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  writeComparison(spec: ComparisonSpec, variants: ComparisonVariant[], report: string): string {
    const dir = comparisonDir(this.root, spec.id);
    mkdirSync(path.join(dir, "variants"), { recursive: true });
    writeJson(path.join(dir, "spec.json"), spec);
    for (const variant of variants) {
      this.writeVariant(spec.id, variant);
    }
    writeFileSync(path.join(dir, "report.md"), report, "utf8");
    return dir;
  }

  /**
   * 只写一路的 `variants/<name>/`（meta.json、output.md、reasoning.md）；补跑单路时用。
   * `--repeat n` 时 meta.json 多 `runs`（无正文，正文在节点），并逐次写 `run-<k>.md`；`output.md` 是第 1 次。
   */
  writeVariant(comparisonId: string, variant: ComparisonVariant): string {
    const variantDir = path.join(comparisonDir(this.root, comparisonId), "variants", safeVariantName(variant.configName));
    mkdirSync(variantDir, { recursive: true });
    const meta: Record<string, unknown> = {
      configName: variant.configName,
      config: variant.config,
      usage: variant.usage,
      latencyMs: variant.latencyMs,
      error: variant.error,
      nodeId: variant.nodeId,
      cost: variant.cost,
      requestId: variant.requestId,
    };
    for (const file of readdirSync(variantDir)) {
      if (/^run-\d+\.md$/u.test(file)) {
        rmSync(path.join(variantDir, file));
      }
    }
    if (variant.runs !== undefined && variant.runs.length > 1) {
      meta.runs = variant.runs.map((run) => ({
        nodeId: run.nodeId,
        usage: run.usage,
        latencyMs: run.latencyMs,
        error: run.error,
        cost: run.cost,
        requestId: run.requestId,
      }));
      variant.runs.forEach((run, index) => {
        writeFileSync(
          path.join(variantDir, `run-${String(index + 1)}.md`),
          renderVariantRun(variant, run, index + 1),
          "utf8",
        );
      });
    }
    writeJson(path.join(variantDir, "meta.json"), meta);
    writeFileSync(path.join(variantDir, "output.md"), renderVariantMarkdown(variant), "utf8");
    const reasoningPath = path.join(variantDir, "reasoning.md");
    if (variant.reasoning !== null && variant.reasoning !== "") {
      writeFileSync(reasoningPath, renderVariantReasoning(variant), "utf8");
    } else if (existsSync(reasoningPath)) {
      rmSync(reasoningPath);
    }
    return variantDir;
  }

  comparisonExists(comparisonId: string): boolean {
    return existsSync(path.join(comparisonDir(this.root, comparisonId), "spec.json"));
  }

  /** 只重写 report.md（例如打分后追加列）。 */
  writeComparisonReport(comparisonId: string, report: string): string {
    const filePath = path.join(comparisonDir(this.root, comparisonId), "report.md");
    writeFileSync(filePath, report, "utf8");
    return filePath;
  }

  writeScores(comparisonId: string, scores: ComparisonScores): string {
    const filePath = path.join(comparisonDir(this.root, comparisonId), "scores.json");
    writeJson(filePath, scores);
    return filePath;
  }

  /** 删掉 scores.json（成稿变了旧分数就不作数）；返回是否真的删了。 */
  deleteScores(comparisonId: string): boolean {
    const filePath = path.join(comparisonDir(this.root, comparisonId), "scores.json");
    if (!existsSync(filePath)) {
      return false;
    }
    rmSync(filePath);
    return true;
  }

  readScores(comparisonId: string): ComparisonScores | null {
    const filePath = path.join(comparisonDir(this.root, comparisonId), "scores.json");
    if (!existsSync(filePath)) {
      return null;
    }
    return parseComparisonScores(readJson(filePath));
  }

  /**
   * 读回一次对比：spec + 各路结果。成稿与思维链从会话节点取，
   * 所以节点被删时会抛错，而不是默默给空文本。
   */
  readComparison(comparisonId: string): StoredComparison {
    const dir = comparisonDir(this.root, comparisonId);
    const specPath = path.join(dir, "spec.json");
    if (!existsSync(specPath)) {
      throw new Error(`找不到对比：${comparisonId}（期望 ${specPath}）`);
    }
    const spec = parseComparisonSpec(readJson(specPath));
    const variants = spec.configs.map((ref) => {
      const metaPath = path.join(dir, "variants", safeVariantName(ref), "meta.json");
      if (!existsSync(metaPath)) {
        throw new Error(`对比 ${comparisonId} 缺少 ${ref} 的 meta.json`);
      }
      const meta = readJson(metaPath);
      if (!isRecord(meta)) {
        throw new Error(`对比 ${comparisonId} 的 ${ref}/meta.json 格式无效`);
      }
      const sessionId = spec.sessionId;
      if (sessionId === null) {
        throw new Error(`对比 ${comparisonId} 没有关联会话，无法读回成稿`);
      }
      const readRun = (rawNodeId: unknown, label: string): VariantRun => {
        const nodeId = requireNullableString(rawNodeId, label);
        if (nodeId === null) {
          throw new Error(`对比 ${comparisonId} 的 ${ref} 没有关联节点，无法读回成稿`);
        }
        return runFromNode(this.getNode(sessionId, nodeId));
      };
      const runs: VariantRun[] =
        Array.isArray(meta.runs) && meta.runs.length > 1
          ? meta.runs.map((item, index) =>
              readRun(isRecord(item) ? item.nodeId : null, `runs[${String(index)}].nodeId`),
            )
          : [readRun(meta.nodeId, "nodeId")];
      const firstNodeId = runs[0]?.nodeId ?? null;
      const config = firstNodeId === null ? parseConfigSnapshot(meta.config) : this.getNode(sessionId, firstNodeId).config;
      return variantFromRuns(ref, config, runs);
    });
    return { spec, variants, dir };
  }

  private parseSessionMeta(raw: unknown): SessionMeta {
    if (!isRecord(raw)) {
      throw new Error("meta.json 格式无效");
    }
    return {
      id: requireString(raw.id, "id"),
      title: requireString(raw.title, "title"),
      createdAt: requireString(raw.createdAt, "createdAt"),
      updatedAt: requireString(raw.updatedAt, "updatedAt"),
      defaultConfig: requireString(raw.defaultConfig, "defaultConfig"),
      defaultSystem: requireNullableString(raw.defaultSystem, "defaultSystem"),
    };
  }

  private parseBranch(raw: unknown): BranchRecord {
    if (!isRecord(raw)) {
      throw new Error("branch JSON 格式无效");
    }
    return {
      name: requireString(raw.name, "name"),
      head: requireNullableString(raw.head, "head"),
      createdFrom: requireNullableString(raw.createdFrom, "createdFrom"),
    };
  }
}
