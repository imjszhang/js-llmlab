import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  BranchRecord,
  ComparisonSpec,
  ComparisonVariant,
  SessionMeta,
  SessionNode,
} from "../types.ts";
import { safeVariantName } from "./config.ts";
import { createId } from "./ids.ts";
import {
  comparisonDir,
  getComparisonsDir,
  getSessionsDir,
  sessionDir,
} from "./paths.ts";
import { renderTurn, renderVariantMarkdown } from "./render.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`字段 ${field} 必须是字符串`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, field);
}

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

  writeNode(sessionId: string, node: SessionNode): void {
    const dir = sessionDir(this.root, sessionId);
    writeJson(path.join(dir, "nodes", `${node.id}.json`), node);
    writeFileSync(path.join(dir, "turns", `${node.id}.md`), renderTurn(node), "utf8");
    this.updateSession(sessionId, {});
  }

  getNode(sessionId: string, nodeId: string): SessionNode {
    const filePath = path.join(sessionDir(this.root, sessionId), "nodes", `${nodeId}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`找不到节点：${sessionId}/${nodeId}`);
    }
    return this.parseNode(readJson(filePath));
  }

  listNodes(sessionId: string): SessionNode[] {
    const dir = path.join(sessionDir(this.root, sessionId), "nodes");
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.parseNode(readJson(path.join(dir, file))))
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
      const variantDir = path.join(dir, "variants", safeVariantName(variant.configName));
      mkdirSync(variantDir, { recursive: true });
      writeJson(path.join(variantDir, "meta.json"), {
        config: variant.config,
        usage: variant.usage,
        latencyMs: variant.latencyMs,
        error: variant.error,
        nodeId: variant.nodeId,
      });
      writeFileSync(path.join(variantDir, "output.md"), renderVariantMarkdown(variant), "utf8");
    }
    writeFileSync(path.join(dir, "report.md"), report, "utf8");
    return dir;
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

  private parseNode(raw: unknown): SessionNode {
    if (!isRecord(raw) || !isRecord(raw.config) || !isRecord(raw.messages)) {
      throw new Error("node JSON 格式无效");
    }
    const usageRaw = raw.usage;
    let usage: SessionNode["usage"] = null;
    if (usageRaw !== null && usageRaw !== undefined) {
      if (!isRecord(usageRaw)) {
        throw new Error("usage 格式无效");
      }
      usage = {
        promptTokens: Number(usageRaw.promptTokens),
        completionTokens: Number(usageRaw.completionTokens),
        totalTokens: Number(usageRaw.totalTokens),
        reasoningTokens:
          usageRaw.reasoningTokens === undefined || usageRaw.reasoningTokens === null
            ? null
            : Number(usageRaw.reasoningTokens),
      };
    }
    return {
      id: requireString(raw.id, "id"),
      parentId: requireNullableString(raw.parentId, "parentId"),
      createdAt: requireString(raw.createdAt, "createdAt"),
      config: {
        name: requireString(raw.config.name, "config.name"),
        provider:
          raw.config.provider === undefined || raw.config.provider === null
            ? null
            : requireString(raw.config.provider, "config.provider"),
        baseURL: requireString(raw.config.baseURL, "config.baseURL"),
        model: requireString(raw.config.model, "config.model"),
        temperature: Number(raw.config.temperature),
        maxTokens: Number(raw.config.maxTokens),
        thinking:
          raw.config.thinking === undefined || raw.config.thinking === null
            ? null
            : raw.config.thinking === "enabled" || raw.config.thinking === "disabled"
              ? raw.config.thinking
              : null,
        reasoningEffort:
          raw.config.reasoningEffort === undefined || raw.config.reasoningEffort === null
            ? null
            : raw.config.reasoningEffort === "low" ||
                raw.config.reasoningEffort === "high" ||
                raw.config.reasoningEffort === "max"
              ? raw.config.reasoningEffort
              : null,
      },
      systemPreset: requireNullableString(raw.systemPreset, "systemPreset"),
      userPreset: requireNullableString(raw.userPreset, "userPreset"),
      messages: {
        system: requireString(raw.messages.system, "messages.system"),
        user: requireString(raw.messages.user, "messages.user"),
        assistant: requireString(raw.messages.assistant, "messages.assistant"),
        reasoning:
          raw.messages.reasoning === undefined
            ? null
            : requireNullableString(raw.messages.reasoning, "messages.reasoning"),
      },
      usage,
      latencyMs: Number(raw.latencyMs),
      error: requireNullableString(raw.error, "error"),
    };
  }
}
