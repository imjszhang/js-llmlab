import type { ResolvedConfig } from "../types.ts";

export type ProviderModel = {
  id: string;
  ownedBy: string | null;
};

export type ProviderModelsDeps = {
  fetch?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redact(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("***");
}

function readModel(row: unknown): ProviderModel | null {
  if (typeof row === "string" && row !== "") return { id: row, ownedBy: null };
  if (!isRecord(row)) return null;
  const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
  if (id === "") return null;
  const ownedBy = typeof row.owned_by === "string" ? row.owned_by : typeof row.owner === "string" ? row.owner : null;
  return { id, ownedBy };
}

/** Anthropic uses a native, cursor-paginated Models API even with OpenAI chat compatibility. */
export async function listModels(config: ResolvedConfig, deps: ProviderModelsDeps = {}): Promise<ProviderModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(new Error(`列出模型超时（${String(config.timeoutMs)} ms）`)); }, config.timeoutMs);
  try {
    const url = new URL(config.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
      throw new Error("模型列表 baseURL 必须为不含用户名和密码的 HTTP/HTTPS 地址");
    }
    const anthropic = config.provider === "anthropic" || url.hostname === "api.anthropic.com";
    let prefix = url.pathname.replace(/\/+$/u, "");
    if (url.hostname === "api.anthropic.com" && prefix === "") prefix = "/v1";
    url.pathname = `${prefix}/models`;
    const headers = new Headers({ accept: "application/json" });
    if (anthropic) {
      headers.set("x-api-key", config.apiKey);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${config.apiKey}`);
    }
    const models = new Map<string, ProviderModel>();
    const cursors = new Set<string>();
    for (;;) {
      const response = await (deps.fetch ?? fetch)(url.toString(), {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`列出模型失败：HTTP ${String(response.status)} ${redact(text, config.apiKey).slice(0, 200)}`);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error("列出模型失败：响应不是有效 JSON"); }
      const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      if (anthropic && (!isRecord(body) || !Array.isArray(body.data))) {
        throw new Error("列出模型失败：Anthropic 响应缺少 data 数组");
      }
      for (const row of rows) {
        const model = readModel(row);
        if (model !== null && !models.has(model.id)) models.set(model.id, model);
      }
      if (!anthropic || !isRecord(body) || body.has_more !== true) break;
      const cursor = body.last_id;
      if (typeof cursor !== "string" || cursor === "" || cursors.has(cursor)) {
        throw new Error("列出模型失败：Anthropic 分页游标缺失或重复，无法完整读取模型列表");
      }
      cursors.add(cursor);
      url.searchParams.set("after_id", cursor);
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    const message = controller.signal.aborted ? `列出模型超时（${String(config.timeoutMs)} ms）` : error instanceof Error ? error.message : String(error);
    throw new Error(redact(message, config.apiKey));
  } finally {
    clearTimeout(timer);
  }
}
