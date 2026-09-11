import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCompare } from "../src/commands/compare.ts";
import {
  idLikeHeaders,
  redactSecrets,
  requestIdFromError,
  requestIdFromHeaders,
  serializeError,
} from "../src/lib/client.ts";
import { parseSessionNode } from "../src/lib/parse.ts";
import { LabStore } from "../src/lib/store.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync } from "./helpers.ts";

const silent = (): void => {};
const KEY = "sk-test-abc"; // makeCommandLab 里 TEST_KEY 的值，可辨识

test("成功与失败节点都有 raw 文件；失败含错误序列化；密钥在 raw / 节点 / turn 里都 grep 不到", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({
    a: { text: "成稿 A", requestId: "req-a-001" },
    // 故意把 key 塞进报错文本，模拟网关回显请求头
    b: { failTimes: 1, error: `401 Unauthorized: bad key ${KEY}`, status: 401, requestId: "req-b-500" },
  });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "题" }, { root, complete: fake.complete, log: silent }),
  );

  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const nodes = store.listNodes(sessionId);
  assert.equal(nodes.length, 2, "listNodes 不应把 .raw.json 当节点");
  const ok = nodes.find((n) => n.error === null);
  const bad = nodes.find((n) => n.error !== null);
  assert.ok(ok && bad);

  const sessionDir = path.join(root, "data", "sessions", sessionId);
  for (const node of [ok, bad]) {
    const rawPath = path.join(sessionDir, "nodes", `${node.id}.raw.json`);
    assert.equal(existsSync(rawPath), true, `缺 raw：${node.id}`);
    const rawText = readFileSync(rawPath, "utf8");
    const nodeText = readFileSync(path.join(sessionDir, "nodes", `${node.id}.json`), "utf8");
    const turnText = readFileSync(path.join(sessionDir, "turns", `${node.id}.md`), "utf8");
    for (const text of [rawText, nodeText, turnText]) {
      assert.equal(text.includes(KEY), false, `密钥泄漏到 ${node.id}`);
      assert.doesNotMatch(text, /Authorization|Bearer/u);
    }
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    assert.equal(raw.nodeId, node.id);
    assert.ok(typeof raw.capturedAt === "string");
    const request = raw.request as Record<string, unknown>;
    assert.equal(request.model, node.config.model);
    assert.ok(Array.isArray(request.messages));
  }

  const okRaw = JSON.parse(readFileSync(path.join(sessionDir, "nodes", `${ok.id}.raw.json`), "utf8")) as Record<string, unknown>;
  assert.equal(okRaw.error, null);
  assert.equal(okRaw.requestId, "req-a-001");
  assert.equal(okRaw.systemFingerprint, "fp_fake");
  assert.equal(okRaw.chunkCount, null);
  assert.ok(okRaw.response !== null);

  const badRaw = JSON.parse(readFileSync(path.join(sessionDir, "nodes", `${bad.id}.raw.json`), "utf8")) as Record<string, unknown>;
  assert.equal(badRaw.response, null);
  const err = badRaw.error as Record<string, unknown>;
  assert.equal(err.name, "Error");
  assert.equal(err.status, 401);
  assert.equal(err.requestId, "req-b-500");
  assert.match(String(err.message), /401 Unauthorized: bad key \*\*\*/u);
  assert.ok(err.body !== undefined);
  assert.equal(bad.error, "401 Unauthorized: bad key ***");

  // requestId 落节点与 turn md
  assert.equal(ok.requestId, "req-a-001");
  assert.equal(bad.requestId, "req-b-500");
  const okTurn = readFileSync(path.join(sessionDir, "turns", `${ok.id}.md`), "utf8");
  assert.match(okTurn, /^- requestId: req-a-001$/mu);

  // raw 内容不进 report.md / turn md
  assert.doesNotMatch(okTurn, /fp_fake|fake-completion/u);
  const cmpId = readdirSync(path.join(root, "data", "comparisons"))[0] ?? "";
  const cmpDir = path.join(root, "data", "comparisons", cmpId);
  const report = readFileSync(path.join(cmpDir, "report.md"), "utf8");
  assert.doesNotMatch(report, /fp_fake|fake-completion|capturedAt/u);
  assert.equal(report.includes(KEY), false);

  // compare 的 meta.json 记录 requestId
  const metaA = JSON.parse(readFileSync(path.join(cmpDir, "variants", "a", "meta.json"), "utf8")) as Record<string, unknown>;
  assert.equal(metaA.requestId, "req-a-001");
  assert.equal(store.readComparison(cmpId).variants[0]?.requestId, "req-a-001");
  assert.equal(store.readComparison(cmpId).variants[1]?.requestId, "req-b-500");

  // readNodeRaw
  assert.equal((store.readNodeRaw(sessionId, ok.id) as Record<string, unknown>).requestId, "req-a-001");
  assert.equal(store.readNodeRaw(sessionId, "n_nope"), null);
});

test("网关不返回 request id 时为 null；旧节点没有 requestId 字段照常解析", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({}, { text: "无 id" });
  await withEnvAsync(env, () =>
    runCompare({ configs: "a,b", message: "q" }, { root, complete: fake.complete, log: silent }),
  );
  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const node = store.listNodes(sessionId)[0];
  assert.equal(node?.requestId, null);
  const turn = readFileSync(path.join(root, "data", "sessions", sessionId, "turns", `${node?.id ?? ""}.md`), "utf8");
  assert.match(turn, /^- requestId: null$/mu);

  const legacy = parseSessionNode({
    id: "n_old",
    parentId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    config: { name: "old", provider: null, baseURL: "https://x", model: "m", temperature: 1, maxTokens: 10, thinking: null, reasoningEffort: null },
    systemPreset: null,
    userPreset: null,
    messages: { system: "", user: "u", assistant: "a", reasoning: null },
    usage: null,
    latencyMs: 1,
    error: null,
  });
  assert.equal(legacy.requestId, null);
  assert.equal(legacy.cost, null);
});

test("serializeError / requestIdFromError / redactSecrets", () => {
  const plain = serializeError(new Error("boom"));
  assert.equal(plain.name, "Error");
  assert.equal(plain.message, "boom");
  assert.equal("status" in plain, false);
  assert.ok(typeof plain.stack === "string");

  const api = Object.assign(new Error("Rate limited"), {
    status: 429,
    code: "rate_limit",
    requestID: "req-xyz",
    error: { message: "slow down" },
    headers: { authorization: "Bearer sk-should-not-appear" },
  });
  const out = serializeError(api);
  assert.equal(out.status, 429);
  assert.equal(out.code, "rate_limit");
  assert.equal(out.requestId, "req-xyz");
  assert.deepEqual(out.body, { message: "slow down" });
  assert.equal("headers" in out, false, "不应整个序列化 headers");
  assert.equal(JSON.stringify(out).includes("sk-should-not-appear"), false);

  assert.equal(requestIdFromError(null), null);
  assert.equal(requestIdFromError(new Error("x")), null);
  assert.equal(requestIdFromError({ headers: new Headers({ "x-request-id": "hdr-1" }) }), "hdr-1");
  assert.equal(requestIdFromError({ headers: { "x-request-id": "hdr-2" } }), "hdr-2");
  // llmcore（one-api 系）没有 x-request-id，只有 x-oneapi-request-id
  const oneapi = new Headers({ "x-oneapi-request-id": "2026091117", "x-keybalancer-request-id": "kb-1", "content-type": "application/json" });
  assert.equal(requestIdFromHeaders(oneapi), "2026091117");
  assert.deepEqual(idLikeHeaders(oneapi), { "x-oneapi-request-id": "2026091117", "x-keybalancer-request-id": "kb-1" });
  assert.equal(requestIdFromHeaders(new Headers({ "content-type": "text/plain" })), null);
  assert.equal(requestIdFromHeaders(undefined), null);

  assert.equal(redactSecrets("key=sk-1 and sk-1 again", ["sk-1"]), "key=*** and *** again");
  assert.equal(redactSecrets("untouched", [""]), "untouched");
  assert.equal(serializeError("字符串错误").message, "字符串错误");
});
