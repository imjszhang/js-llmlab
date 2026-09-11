import assert from "node:assert/strict";
import { test } from "node:test";
import { runOnce } from "../src/commands/run.ts";
import { LabStore } from "../src/lib/store.ts";
import type { SessionNode } from "../src/types.ts";
import { createFakeCompleter } from "./fake-completer.ts";
import { makeCommandLab, withEnvAsync } from "./helpers.ts";

const silent = (): void => {};

type Captured = {
  out: string[];
  chunks: string[];
  err: string[];
  errChunks: string[];
};

function capture(): Captured & {
  deps: {
    log: (l: string) => void;
    write: (c: string) => void;
    error: (l: string) => void;
    writeErr: (c: string) => void;
  };
} {
  const out: string[] = [];
  const chunks: string[] = [];
  const err: string[] = [];
  const errChunks: string[] = [];
  return {
    out,
    chunks,
    err,
    errChunks,
    deps: {
      log: (l) => out.push(l),
      write: (c) => chunks.push(c),
      error: (l) => err.push(l),
      writeErr: (c) => errChunks.push(c),
    },
  };
}

function onlyNode(root: string): SessionNode {
  const store = new LabStore(root);
  const sessionId = store.listSessions()[0]?.id ?? "";
  const node = store.listNodes(sessionId)[0];
  assert.ok(node);
  return node;
}

test("run --stream：onDelta 分三段推，stdout 拼接等于最终 assistant；思维链变暗走 stderr", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ "model-a": { text: "这是一段流式成稿", reasoning: "先想一想" } });
  const cap = capture();

  await withEnvAsync(env, () =>
    runOnce(
      { config: "model-a", message: "q", stream: true },
      { root, complete: fake.complete, isTTY: true, ...cap.deps },
    ),
  );

  assert.equal(fake.calls[0]?.options.stream, true);
  const node = onlyNode(root);
  assert.equal(node.error, null);
  // 三段增量 + 收尾换行；拼起来（去掉尾换行）等于成稿
  assert.equal(cap.chunks.length, 4);
  assert.equal(cap.chunks.slice(0, 3).join(""), node.messages.assistant);
  assert.equal(cap.chunks[3], "\n");
  // stdout 整行输出为空：成稿只以增量形式出现一次，不重复打印
  assert.deepEqual(cap.out, []);
  // 思维链走 stderr，带 [reasoning] 头，内容原样在（chalk 在非 TTY 下不加色）
  assert.ok(cap.err.some((l) => l.includes("[reasoning]")));
  assert.ok(cap.errChunks.join("").includes("先想一想"));
  // 收尾的 session 行走 stderr
  assert.ok(cap.err.some((l) => l.includes(`node=${node.id}`)));
});

test("run --stream --hide-reasoning：stderr 里没有思维链，stdout 照常拼出成稿", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ "model-a": { text: "成稿", reasoning: "不该出现的思维链" } });
  const cap = capture();

  await withEnvAsync(env, () =>
    runOnce(
      { config: "model-a", message: "q", stream: true, hideReasoning: true },
      { root, complete: fake.complete, isTTY: true, ...cap.deps },
    ),
  );

  assert.equal(cap.chunks.slice(0, -1).join(""), "成稿");
  assert.equal(cap.errChunks.join(""), "");
  assert.ok(!cap.err.some((l) => l.includes("[reasoning]")));
  // 但思维链照常落盘
  assert.equal(onlyNode(root).messages.reasoning, "不该出现的思维链");
});

test("流式与非流式落盘的节点结构一致：同字段、同 usage 口径", async () => {
  const streamed = makeCommandLab();
  const plain = makeCommandLab();
  const reply = { text: "同一段成稿", reasoning: "同一段思维链" };

  await withEnvAsync(streamed.env, () =>
    runOnce(
      { config: "model-a", message: "q", stream: true },
      { root: streamed.root, complete: createFakeCompleter({ "model-a": reply }).complete, isTTY: false, log: silent, write: silent, error: silent, writeErr: silent },
    ),
  );
  await withEnvAsync(plain.env, () =>
    runOnce(
      { config: "model-a", message: "q" },
      { root: plain.root, complete: createFakeCompleter({ "model-a": reply }).complete, isTTY: false, log: silent, write: silent, error: silent, writeErr: silent },
    ),
  );

  const a = onlyNode(streamed.root);
  const b = onlyNode(plain.root);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.deepEqual(Object.keys(a.messages).sort(), Object.keys(b.messages).sort());
  assert.deepEqual(a.usage, b.usage);
  assert.equal(a.messages.assistant, b.messages.assistant);
  assert.equal(a.messages.reasoning, b.messages.reasoning);
  assert.deepEqual(a.config, b.config);
});

test("非流式：TTY 上每隔 interval 往 stderr 打进度，stdout 只有成稿；非 TTY 一行进度都没有", async () => {
  const slow = { "model-a": { text: "慢慢来的成稿", delayMs: 60 } };

  const tty = makeCommandLab();
  const capTty = capture();
  await withEnvAsync(tty.env, () =>
    runOnce(
      { config: "model-a", message: "q" },
      { root: tty.root, complete: createFakeCompleter(slow).complete, isTTY: true, progressIntervalMs: 10, ...capTty.deps },
    ),
  );
  const progress = capTty.err.filter((l) => l.includes("等待"));
  assert.ok(progress.length >= 2, `期望至少 2 行进度，实际 ${String(progress.length)}`);
  assert.ok(progress.every((l) => /\d+s$/.test(l)), "进度行以 elapsed 秒数结尾");
  assert.deepEqual(capTty.out, ["慢慢来的成稿"]);
  assert.deepEqual(capTty.chunks, []);

  const pipe = makeCommandLab();
  const capPipe = capture();
  await withEnvAsync(pipe.env, () =>
    runOnce(
      { config: "model-a", message: "q" },
      { root: pipe.root, complete: createFakeCompleter(slow).complete, isTTY: false, progressIntervalMs: 10, ...capPipe.deps },
    ),
  );
  assert.deepEqual(capPipe.out, ["慢慢来的成稿"]);
  assert.equal(capPipe.err.filter((l) => l.includes("等待")).length, 0);
  assert.ok(!capPipe.out.some((l) => l.includes("等待")));
});

test("run --stream 中途失败：已打的增量后补换行，错误走 stderr，exitCode 置 1", async () => {
  const { root, env } = makeCommandLab();
  const fake = createFakeCompleter({ "model-a": { failTimes: 1, error: "网关抽风" } });
  const cap = capture();
  const before = process.exitCode;

  await withEnvAsync(env, () =>
    runOnce(
      { config: "model-a", message: "q", stream: true },
      { root, complete: fake.complete, isTTY: true, ...cap.deps },
    ),
  );

  assert.equal(process.exitCode, 1);
  process.exitCode = before;
  assert.deepEqual(cap.out, []);
  assert.ok(cap.err.some((l) => l.includes("请求失败") && l.includes("网关抽风")));
  assert.equal(onlyNode(root).error, "网关抽风");
});
