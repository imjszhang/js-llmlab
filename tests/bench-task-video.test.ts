import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTask } from "../src/lib/bench/config.ts";
import { gradeTask } from "../src/lib/bench/grader.ts";
import { runProcess } from "../src/lib/bench/process.ts";
import { loadBenchSuite } from "../src/lib/bench/suite.ts";
import { materializeFixture } from "../src/lib/bench/workspace.ts";
import type { BenchTask, ExecutionResult, GradeResult } from "../src/lib/bench/types.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tasks/fixtures/neural-network-video");
const checker = readFileSync(path.join(root, "tasks/checks/neural-network-video.mjs"), "utf8");
const fakeProbe = `#!${process.execPath}
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const args = process.argv.slice(2);
assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
assert.equal(args[args.indexOf("-format_whitelist") + 1], "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm");
assert.ok(args.includes("-count_frames"));
assert.ok(args.includes("-show_format"));
const filename = args[args.indexOf("-i") + 1];
const metadata = JSON.parse(readFileSync(filename, "utf8"));
if (metadata.invalidContainer) { console.error("invalid test container"); process.exit(1); }
if (metadata.invalidJson) { console.log("not JSON"); process.exit(0); }
console.log(JSON.stringify(metadata));
`;

function execution(): ExecutionResult {
  return {
    status: "completed", text: "done", reasoning: null, usage: null, cost: null, sessionId: null,
    responseModel: null, events: [], error: null, latencyMs: 0, exitCode: 0, stdout: "", stderr: "",
    raw: null, harnessVersion: null, usageSource: null, costSource: null,
  };
}

function videoMetadata(stream: Record<string, unknown> = {}, duration: unknown = "15.5") {
  return {
    streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920,
      sample_aspect_ratio: "1:1", nb_read_frames: "12", ...stream }],
    format: { duration, format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
  };
}

function setup(t: { after: (fn: () => void) => void }, copyFixture = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "llmlab video checker "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "candidate workspace");
  const bin = path.join(directory, "trusted tool bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  if (copyFixture) cpSync(fixture, workspace, { recursive: true });
  const executable = path.join(bin, "ffprobe");
  const probeSource = path.join(bin, "ffprobe.mjs");
  writeFileSync(probeSource, fakeProbe);
  chmodSync(probeSource, 0o755);
  symlinkSync(probeSource, executable);
  const technicalTask: BenchTask = {
    name: "neural-network-video", prompt: "test", timeoutMs: 3600000,
    checks: [{ kind: "command", argv: [process.execPath, "--input-type=module", "-e", checker], timeoutMs: 30000 }],
  };
  const grade = (task = technicalTask, toolPath = bin): Promise<GradeResult> => gradeTask(task, execution(), workspace, {
    runProcess: async (request) => {
      assert.ok(request.executable === process.execPath || request.executable === "node");
      assert.deepEqual(request.env, {});
      return runProcess({ ...request, executable: process.execPath, env: { PATH: toolPath } });
    },
  });
  const code = (name = "render video.mjs", content = 'throw new Error("candidate source must never be executed by the checker");\n') => {
    mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    writeFileSync(path.join(workspace, name), content);
  };
  const video = (name = "output/神经网络 final.mp4", metadata: unknown = videoMetadata()) => {
    mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    writeFileSync(path.join(workspace, name), JSON.stringify(metadata));
  };
  return { workspace, bin, directory, grade, code, video };
}

test("neural-network-video appends only rendered MP4 delivery and Chinese readability self-review requirements to the portable original prompt", () => {
  const task = loadTask(root, "neural-network-video");
  const original = readFileSync(path.join(root, "tasks/prompts/neural-network-video.original.md"), "utf8");
  assert.equal(original.trim(), "帮我做一个中文版的科普爆款视频。全代码实现。解释清楚什么是：神经网络。\n样式参考：@/Users/jszhang/github/my/js-designer-skill/references/aipoch-investor-deck。竖屏。 不要参考别的项目。");
  const portableOriginal = original.replace("@/Users/jszhang/github/my/js-designer-skill/references/aipoch-investor-deck", "@./style/aipoch-investor-deck").trim();
  assert.equal(task.prompt.trim(), `${portableOriginal}\n必须实际渲染并输出可播放的 MP4，不能只交 HTML 或源码。\n必须保证中文字体正常、文字清晰可读，交付前检查实际渲染画面并自行修复问题。`);
  assert.ok(!task.prompt.includes("/Users/"));
  assert.equal(task.timeoutMs, 3600000);
  assert.equal(task.requires, "workspace-write");
  assert.equal(task.fixture, "tasks/fixtures/neural-network-video");
  assert.deepEqual(task.manifest, { immutable: ["style/**"], allowNewFiles: true });
  const command = task.checks.find((check) => check.kind === "command" && check.argv.includes(checker));
  assert.ok(command?.kind === "command");
  assert.equal(command.timeoutMs, 30000);
  assert.deepEqual(command.argv.slice(1), ["--input-type=module", "-e", checker]);
  assert.equal(task.selfTest, undefined, "metadata doubles are not a real reference video self-test");
});

test("neural-network-video style snapshot is self-contained and copied bytes match its source provenance", () => {
  const style = path.join(fixture, "style/aipoch-investor-deck");
  const provenance: unknown = JSON.parse(readFileSync(path.join(style, "provenance.json"), "utf8"));
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  assert.ok(object(provenance));
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.referenceOnly, true);
  assert.equal(provenance.license, "not-published");
  assert.equal(typeof provenance.sourceDirectory, "string");
  assert.equal(path.isAbsolute(String(provenance.sourceDirectory)), false);
  assert.ok(Array.isArray(provenance.files));
  const described = new Set<string>();
  for (const entry of provenance.files) {
    assert.ok(object(entry));
    assert.equal(typeof entry.file, "string");
    assert.equal(typeof entry.sourceSha256, "string");
    assert.equal(typeof entry.snapshotSha256, "string");
    const file = String(entry.file);
    assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."));
    assert.ok(!described.has(file));
    described.add(file);
    assert.match(String(entry.sourceSha256), /^[a-f0-9]{64}$/u);
    const actual = createHash("sha256").update(readFileSync(path.join(style, file))).digest("hex");
    assert.equal(entry.snapshotSha256, actual, file);
    assert.ok(entry.handling === "copied" || entry.handling === "adapted");
    if (entry.handling === "copied") assert.equal(entry.sourceSha256, actual, `byte-for-byte source copy: ${file}`);
  }
  const files = (directory: string, prefix = ""): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    assert.equal(entry.isSymbolicLink(), false);
    return entry.isDirectory() ? files(path.join(directory, entry.name), relative) : [relative];
  });
  const snapshotFiles = files(style);
  assert.deepEqual([...described].sort(), snapshotFiles.filter((file) => file !== "provenance.json").sort());
  assert.equal(snapshotFiles.filter((file) => file.endsWith(".png")).length, 4);
  for (const file of snapshotFiles) {
    assert.ok(/\.(?:md|json|png)$/u.test(file), `no source code or finished video supplied: ${file}`);
    if (file.endsWith(".png")) {
      assert.deepEqual([...readFileSync(path.join(style, file)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      continue;
    }
    assert.doesNotMatch(readFileSync(path.join(style, file), "utf8"), /\/Users\/|\/home\/|file:\/\/|https?:\/\/|@\.\.\/|\/Volumes\//u, file);
  }
});

test("neural-network-video Opus suite resolves one independent Claude Code run using the Anthropic provider", () => {
  const suite = loadBenchSuite(root, "neural-network-video-opus");
  assert.equal(suite.repeat, 1);
  assert.equal(suite.concurrency, 1);
  assert.deepEqual(suite.tasks.map((task) => task.name), ["neural-network-video"]);
  assert.deepEqual(suite.targets.map((target) => target.name), ["cc-opus-5-5"]);
  const target = suite.targets[0];
  assert.ok(target?.kind === "harness");
  assert.equal(target.profile.adapter, "claude-code");
  assert.equal(target.profile.permission, "workspace-write");
  assert.notEqual(target.backend.auth, "chatgpt");
  if (target.backend.auth === "chatgpt") throw new Error("expected API-key backend");
  assert.equal(target.backend.provider, "anthropic");
  assert.equal(target.backend.model, "claude-opus-5-5");
  assert.equal(target.backend.protocol, "anthropic-messages");
  assert.equal(target.backend.baseURL, "https://api.anthropic.com");
  assert.equal(target.backend.apiKeyEnv, "ANTHROPIC_API_KEY");
});

test("neural-network-video empty fixture and code without a video fail before any probe is required", async (t) => {
  const candidate = setup(t, true);
  assert.equal((await candidate.grade()).status, "failed");
  candidate.code();
  const checked = await candidate.grade();
  assert.equal(checked.status, "failed");
  assert.match(checked.checks[0]?.stderr ?? "", /no nonempty candidate video/u);
});

test("neural-network-video finds a portrait video with paths containing spaces and never runs candidate source", async (t) => {
  const candidate = setup(t);
  candidate.code("source files/a file;$(literal).mjs");
  candidate.video("final output/中文 video;$(literal).mp4");
  const checked = await candidate.grade();
  assert.equal(checked.status, "passed", JSON.stringify(checked));
  assert.match(checked.checks[0]?.stdout ?? "", /1080\.00x1920\.00/u);
  assert.match(checked.checks[0]?.stdout ?? "", /manual review/u);
  assert.match(checked.checks[0]?.stdout ?? "", /Source code was not executed/u);
  assert.equal(existsSync(path.join(candidate.workspace, "literal")), false);
});

test("neural-network-video rejects broken containers, landscape/square video and incomplete playable metadata", async (t) => {
  const candidate = setup(t);
  candidate.code();
  for (const metadata of [
    { invalidContainer: true },
    videoMetadata({ width: 1920, height: 1080 }),
    videoMetadata({ width: 1080, height: 1080 }),
    videoMetadata({}, "0"),
    videoMetadata({}, "N/A"),
    videoMetadata({ nb_read_frames: "0" }),
    videoMetadata({ nb_read_frames: "N/A" }),
    videoMetadata({ codec_name: "unknown" }),
    videoMetadata({ disposition: { attached_pic: 1 } }),
    videoMetadata({ sample_aspect_ratio: "4:0" }),
    { streams: [], format: { duration: "10" } },
  ]) {
    candidate.video("video.mp4", metadata);
    const checked = await candidate.grade();
    assert.equal(checked.status, "failed", JSON.stringify(metadata));
  }
});

test("neural-network-video evaluates displayed orientation using sample aspect ratio and rotation", async (t) => {
  const candidate = setup(t);
  candidate.code();
  for (const stream of [
    { width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
    { width: 1920, height: 1080, tags: { rotate: "90" } },
    { width: 1920, height: 1080, sample_aspect_ratio: "1:2" },
  ]) {
    candidate.video("video.mp4", videoMetadata(stream));
    const checked = await candidate.grade();
    assert.equal(checked.status, "passed", JSON.stringify(checked));
  }
  candidate.video("video.mp4", videoMetadata({ sample_aspect_ratio: "2:1" }));
  assert.equal((await candidate.grade()).status, "failed", "portrait stored pixels can display as landscape");
  candidate.video("video.mp4", videoMetadata({ side_data_list: [{ rotation: 90 }] }));
  assert.equal((await candidate.grade()).status, "failed", "rotation changes display orientation");
});

test("neural-network-video accepts a valid alternate candidate after rejecting an earlier invalid MP4", async (t) => {
  const candidate = setup(t);
  candidate.code();
  candidate.video("bad.mp4", { invalidContainer: true });
  candidate.video("valid.webm", videoMetadata({ codec_name: "vp9" }));
  const checked = await candidate.grade();
  assert.equal(checked.status, "passed", JSON.stringify(checked));
  assert.match(checked.checks[0]?.stdout ?? "", /valid\.webm/u);
});

test("neural-network-video excludes style and dependency artifacts from candidate code and video discovery", async (t) => {
  const candidate = setup(t);
  for (const directory of ["style", "node_modules", ".git", "archives", ".venv", ".env.private"]) {
    candidate.code(`${directory}/preexisting.mjs`);
    candidate.video(`${directory}/preexisting.mp4`);
  }
  assert.equal((await candidate.grade()).status, "failed");
  candidate.video();
  const missingCode = await candidate.grade();
  assert.equal(missingCode.status, "failed");
  assert.match(missingCode.checks[0]?.stderr ?? "", /no nonempty candidate code/u);
  candidate.code("empty.py", " \n\t");
  assert.equal((await candidate.grade()).status, "failed");
});

test("neural-network-video rejects symlinks rather than inspecting files outside the workspace", async (t) => {
  const candidate = setup(t);
  candidate.code();
  candidate.video();
  const external = path.join(candidate.directory, "outside.mp4");
  writeFileSync(external, JSON.stringify(videoMetadata()));
  symlinkSync(external, path.join(candidate.workspace, "linked.mp4"));
  const checked = await candidate.grade();
  assert.equal(checked.status, "failed");
  assert.match(checked.checks[0]?.stderr ?? "", /symlink is forbidden/u);
});

test("neural-network-video missing ffprobe is an explicit infrastructure diagnostic, including candidate PATH injection", async (t) => {
  const candidate = setup(t);
  candidate.code();
  candidate.video();
  writeFileSync(path.join(candidate.workspace, "ffprobe"), fakeProbe);
  chmodSync(path.join(candidate.workspace, "ffprobe"), 0o755);
  const emptyBin = path.join(candidate.directory, "empty host bin");
  mkdirSync(emptyBin);
  for (const toolPath of [emptyBin, candidate.workspace, "."]) {
    const checked = await candidate.grade(undefined, toolPath);
    assert.equal(checked.status, "failed");
    assert.match(checked.checks[0]?.stderr ?? "", /INFRASTRUCTURE ERROR: ffprobe is required/u);
    assert.match(checked.checks[0]?.detail ?? "", /退出码 2/u);
  }
});

test("neural-network-video style remains immutable while candidate additions are permitted", async (t) => {
  const candidate = setup(t);
  const task = loadTask(root, "neural-network-video");
  materializeFixture(root, task, candidate.workspace);
  candidate.code();
  candidate.video();
  const passed = await candidate.grade(task);
  assert.equal(passed.status, "passed", JSON.stringify(passed));
  const style = path.join(candidate.workspace, "style/aipoch-investor-deck/design.md");
  assert.ok(existsSync(style));
  writeFileSync(style, readFileSync(style, "utf8") + "\nmodified style\n");
  const changed = await candidate.grade(task);
  assert.equal(changed.status, "failed");
  assert.ok(changed.checks.some((check) => !check.passed && /immutable file changed/u.test(check.stderr ?? "")));
});
