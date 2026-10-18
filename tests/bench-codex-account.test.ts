import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codexNetworkEnvironment, listCodexModels, readCodexAccount } from "../src/lib/bench/codex-account.ts";
import type { CodexAccountOptions } from "../src/lib/bench/codex-account.ts";
import type { ProcessRequest, ProcessResult } from "../src/lib/bench/types.ts";

function success(value: unknown): ProcessResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0, signal: null, timedOut: false, error: null, latencyMs: 1 };
}
async function fakeCodex(source: string, status = "Logged in using ChatGPT"): Promise<{ dir: string; options: CodexAccountOptions }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-account-test-"));
  const executable = path.join(dir, "codex");
  await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('login')){process.stderr.write(${JSON.stringify(status)}+'\\n');process.exit(${status === "Not logged in" ? "1" : "0"});}\n${source}\n`);
  await chmod(executable, 0o700);
  return { dir, options: { executable, codexHome: dir, credentialsStore: "file", timeoutMs: 3000 } };
}
const nativeModel = {
  id: "catalog-id", model: "model-id", displayName: "Current model", description: "Account catalog model",
  hidden: false, isDefault: true, defaultReasoningEffort: "future-effort",
  supportedReasoningEfforts: [{ reasoningEffort: "future-effort", description: "Advertised native value" }],
};

test("Codex metadata plans keep credentials native, isolate state and discard identity fields", async () => {
  let request: ProcessRequest | undefined;
  const account = await readCodexAccount({ executable: "codex", codexHome: "/native/auth-home", credentialsStore: "keyring" }, {
    runProcess: async (plan) => {
      request = plan;
      return { ...success({}), stdout: "Logged in using ChatGPT\n" };
    },
  });
  assert.deepEqual(account, { auth: "chatgpt", planType: null });
  assert.ok(request);
  assert.equal(request.executable, "codex");
  assert.equal(request.env?.CODEX_HOME, "/native/auth-home");
  assert.notEqual(request.env?.HOME, process.env.HOME);
  assert.equal(Object.keys(request.env ?? {}).some((key) => /key|token|secret/iu.test(key)), false);
  assert.equal(request.timeoutMs > 0 && request.timeoutMs <= 30_000, true);
  assert.deepEqual(request.args.slice(0, 3), ["--no-daemon", "login", "status"]);
  assert.equal(request.args.includes("cli_auth_credentials_store=\"keyring\""), true);
  assert.equal(request.args.includes("forced_login_method=\"chatgpt\""), false);
  assert.equal(request.args.some((arg: string) => /^model_provider="js_llmlab_metadata_[a-f\d]+"$/u.test(arg)), true);
  assert.equal(request.args.includes("chatgpt_base_url=\"https://chatgpt.com/backend-api/\""), true);
  assert.equal(request.args.some((arg: string) => arg.includes(".model_catalog_url=\"https://chatgpt.com/backend-api/codex/models\"")), true);
  await assert.rejects(access(request.cwd));
});

test("Codex native bridge waits for initialization, pages dynamic models and exports only allowlisted metadata", async () => {
  const item = JSON.stringify(nativeModel);
  const fake = await fakeCodex(`
const readline = require('node:readline');
let initialized = false;
let ready = false;
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize') return setTimeout(()=>{ready=true;send(message.id,{userAgent:'fake',accessToken:'never-forward'});},10);
 if(message.method==='initialized'){initialized=ready;return;}
 if(!initialized) return send(message.id,{error:'not initialized'});
 if(message.method==='account/read') {
  if(message.params.refreshToken!==false) process.exit(9);
  send(message.id,{requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'plus',email:'private@example.invalid',accessToken:'never-forward'}});return;
 }
 if(message.method==='model/list'){
  const model=${item};
  if(message.params.cursor===undefined) send(message.id,{data:[model],nextCursor:'second-page'});
  else if(message.params.cursor==='second-page') send(message.id,{data:[{...model,id:'second-id',model:'second-model',isDefault:false,inputModalities:['text']}],nextCursor:null});
  else process.exit(10);
  return;
 }
 process.exit(11);
});`);
  try {
    const result = await listCodexModels(fake.options);
    assert.deepEqual(result.account, { auth: "chatgpt", planType: null });
    assert.deepEqual(result.models.map((model) => [model.model, model.supportedReasoningEfforts, model.inputModalities]), [
      ["model-id", ["future-effort"], ["text", "image"]], ["second-model", ["future-effort"], ["text"]],
    ]);
    assert.doesNotMatch(JSON.stringify(result), /private|never-forward|accessToken|email/u);
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex model discovery does not list or mutate auth when current login is an API key", async () => {
  const fake = await fakeCodex(`
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.method==='initialized')return;
 if(m.method==='initialize')return console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method!=='account/read')process.exit(8);
 console.log(JSON.stringify({id:m.id,result:{requiresOpenaiAuth:true,account:{type:'apiKey'}}}));
});`, "Logged in using an API key - private-key");
  try { assert.deepEqual(await listCodexModels(fake.options), { account: { auth: "api-key", planType: null }, models: [] }); }
  finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex metadata errors suppress native diagnostics, malformed response payloads and credential values", async () => {
  const options = { executable: "codex", codexHome: "/native/auth-home" };
  for (const result of [
    { ...success({}), exitCode: 4, stderr: "private-key-and-personal-route" },
    success({ error: "private-key-and-personal-route" }),
    { ...success({}), stdout: "private-key-and-personal-route" },
    success({ account: { auth: "chatgpt", planType: "bad\nvalue" }, models: [] }),
  ]) {
    await assert.rejects(readCodexAccount(options, { runProcess: async () => result }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-key|personal-route|bad\n/u);
      return true;
    });
  }
  const fake = await fakeCodex(`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.error('private-key');console.log(JSON.stringify({id:m.id,error:{code:9,message:'private-key'}}));});`);
  try { await assert.rejects(listCodexModels(fake.options), (error: unknown) => error instanceof Error && !error.message.includes("private-key")); }
  finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex metadata rejects repeated pagination and malformed model payloads", async () => {
  const fake = await fakeCodex(`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.method==='initialized')return;
const result=m.method==='initialize'?{}:m.method==='account/read'?{requiresOpenaiAuth:true,account:{type:'chatgpt',planType:'pro'}}:{data:[],nextCursor:'repeated'};
console.log(JSON.stringify({id:m.id,result}));});`);
  try { await assert.rejects(listCodexModels(fake.options), /元数据查询失败/u); }
  finally { await rm(fake.dir, { recursive: true, force: true }); }
  await assert.rejects(listCodexModels({ executable: "codex", codexHome: "/native/home" }, {
    runProcess: async (request) => request.args.includes("login") ? { ...success({}), stdout: "Logged in using ChatGPT\n" }
      : success({ account: { auth: "chatgpt", planType: null }, models: [{ model: "incomplete" }] }),
  }), /模型元数据/u);
});

test("Codex metadata timeout reaps the native child before rejecting", { skip: process.platform === "win32" }, async () => {
  const fake = await fakeCodex(`require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'child.pid'),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  try {
    await assert.rejects(listCodexModels({ ...fake.options, timeoutMs: 1500 }), /超时/u);
    const pid = Number(await readFile(path.join(fake.dir, "child.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0));
  } finally { await rm(fake.dir, { recursive: true, force: true }); }
});

test("Codex metadata validates options before calling a subprocess", async () => {
  let called = false;
  const deps = { runProcess: async () => { called = true; return success({}); } };
  await assert.rejects(readCodexAccount({ executable: "codex", codexHome: "relative" }, deps), /绝对路径/u);
  await assert.rejects(readCodexAccount({ executable: "codex", codexHome: "/native/home", timeoutMs: 0 }, deps), /正整数/u);
  assert.equal(called, false);
});

test("Codex metadata inherits transport proxies without exporting credentials in status", async () => {
  const proxy = process.env.HTTPS_PROXY;
  const key = process.env.OPENAI_API_KEY;
  try {
    process.env.HTTPS_PROXY = "http://proxy-user:proxy-password@127.0.0.1:7890";
    process.env.OPENAI_API_KEY = "provider-key-must-not-pass";
    const environment = codexNetworkEnvironment();
    assert.equal(environment.HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    const status = await readCodexAccount({ executable: "codex", codexHome: "/native/home" }, {
      runProcess: async (request) => {
        assert.equal(request.env?.HTTPS_PROXY, process.env.HTTPS_PROXY);
        assert.equal(request.env?.OPENAI_API_KEY, undefined);
        return { ...success({}), stdout: "Logged in using ChatGPT\n" };
      },
    });
    assert.doesNotMatch(JSON.stringify(status), /proxy-password|provider-key/u);
  } finally {
    if (proxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = proxy;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
  }
});
