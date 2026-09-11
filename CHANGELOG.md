# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。每个 PR 在 Unreleased 下加一行；完成一个里程碑时升版本、打 tag、发 Release。

## [Unreleased]

### Added

- 配置字段 `timeoutMs`（缺省 600000，交给 SDK）与 `maxRetries`（缺省 2，我们这一层指数退避重试，SDK 自身重试关掉）；CLI `--timeout-ms` / `--max-retries`；两项进节点快照，老节点缺字段读成默认值；`config show` 打印。流式一旦开始输出不再重试（#10）。
- 每个节点旁写 `nodes/<id>.raw.json`：请求体（无密钥）、原始响应（流式为拼接后的最终对象 + `chunkCount`）、`systemFingerprint`、像 id 的响应头、失败时的错误序列化；节点与 compare `meta.json` 新增 `requestId`（依次取 `x-request-id` / `x-oneapi-request-id` / `x-keybalancer-request-id` / `request-id` / `cf-ray`），turn md 打印。写盘前把当前 apiKey 打码成 `***`（#11）。
- `compare retry <c_id> [--only a,b] [--concurrency n] [--timeout-ms n] [--max-retries n]`：只补跑失败路（或 `--only` 指定的路），复用原输入 / system / 配置快照，更新对应 `variants/<name>/` 与 `report.md`，删除已失效的 `scores.json` 并提示（#10）。

### Changed

- `compare` 在按名字去重之后再按解析快照（provider、baseURL、model、thinking、effort、temperature、maxTokens）去重，名字不同但请求相同的路只跑一次并在终端提示；`spec.configs` 记录的是去重后的路（#14）。
- `client.ts` 的类型绕过收窄到唯一的 `toSdkParams` 适配函数，流式与非流式响应都用 SDK 自带类型；新增 `tests/hygiene.test.ts` 守住「全仓库 ≤ 1 处 `as never`」（#14）。

## [0.4.0] - 2026-09-11

M2 评估与成本：「像不像」有离线指标，「好不好」有 LLM 裁判，「值不值」有成本列。

### Added

- `compare score <c_id> [--reference <file>] [--baseline <file>]`：对已有对比离线算 `similarity`（字符级 LCS）、`changeRatio`、`barelyChanged`，写 `scores.json`，报表汇总表追加「相似度 | 改动率」列；不发请求（#6）。
- provider / config 支持可选 `pricing: { inputPerMillion, outputPerMillion, currency }`（config 覆盖 provider）；节点新增 `cost: { input, output, total, currency } | null`；turn md、报表汇总表与 `compare` 终端多一列「成本」；`config show` 打印 pricing。价格不预置，网关实际计费以账单为准（#8）。
- `compare score --judge <config> [--rubric <name>] [--concurrency <n>]`：LLM 裁判逐路打 0–10 分，rubric 在 `prompts/judge/<name>.md`（新增 `default`），结果进 `scores.json` 的 `judge` 字段与汇总表「裁判」列，报表末尾附裁判理由；裁判调用落到 `judge: <c_id>` 会话。JSON 解析对中文引号等常见错误有兜底（#7）。

## [0.3.0] - 2026-09-11

M1 并行与报表：compare 从串行 173 秒变成"最慢一路"的时长，报表一眼能看。

### Added

- `compare` 各路并行执行，缺省并发 3，`--concurrency <n>` 可调；结果按输入顺序写入；终端每路开始 / 结束各一行并打总耗时。在线 8 路实测总耗时 = 最慢一路（#4）。

### Changed

- compare 的 `report.md` 改为：元信息 → `## 汇总` 表（配置 | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 错误）→ Input → 各路成稿；思维链不再进 report，改写到 `variants/<配置>/reasoning.md`；`output.md` 只留成稿；终端结束时打同一张表（#5）。

## [0.2.0] - 2026-09-11

M0 地基：网络层可注入、离线冒烟、fixture 与黄金文件。此后所有编排逻辑都能在 CI 里不带 key 验证。

### Added

- `appendTurn` / `run` / `compare` 可注入 completer；新增 `tests/fake-completer.ts`，编排逻辑可离线测试（#1）。
- `run` / `compare` 新增 `--dry-run`：打印配置快照、密钥状态、messages 与请求体 JSON，不发请求、不落盘；CI 冒烟改用它（#2）。
- 测试基础设施：脱敏 fixture `tests/fixtures/polish-8way`、`scripts/export-fixture.ts`（`npm run fixture:export`）、黄金文件比对 `tests/golden.ts`（`npm run test:update-golden`）；`LabStore.readComparison` 可读回对比；落盘 JSON 解析集中到 `src/lib/parse.ts`（#3）。
- GitHub 工程骨架：CI（typecheck + test + 离线冒烟，Node 20 / 22）、issue 与 PR 模板、`master` 分支保护、四个里程碑与 14 个带验收标准的 issue。
- `--version` 改为读 `package.json`，版本号只维护一处。

## [0.1.0] - 2026-09-11

### Added

- 初始化：OpenAI 兼容对话、会话树与分支、多配置对比落盘。
- 多 provider；DeepSeek V4 的 `thinking` 与 `reasoningEffort`。
- `AGENTS.md`；`data/tmp/` 一次性输入目录。
