# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。每个 PR 在 Unreleased 下加一行；完成一个里程碑时升版本、打 tag、发 Release。

## [Unreleased]

- 集成同步官方 API、任务实验框架、五种 harness、原生账号模式及后续代理/视频任务改动，保留各功能 issue 的独立验收记录，不包含本地实验产物（#50）。

- fix(cursor): 修复原图慢传输触发原生 30 秒重连的问题，增加版本与 SHA-256 锁定的内存兼容修复、可快照的内部等待时间和 HTTP/1.1 配置；修正入口被工具 shell 拦截、保留标准代理，并补离线回归（#49）。

### Added

- 新增 Cursor Agent 独立 adapter、只读/可写 profiles 与原生登录/API key targets，支持模型选择及安全状态/动态目录查询；隔离本地配置、启用原生沙箱，保留远端扩展边界，完整用量与费用保持未知，不新增 LLM provider（#47）。
- Claude Code target 支持原生 Claude 订阅登录与显式模型选择，新增安全登录状态查询、Sonnet / Opus 别名 targets 和通用 targets init；冻结认证目录命名空间，订阅费用保持未知，兼容 API targets 与旧记录（#44）。
- 神经网络竖屏科普视频的单次生成任务、原始短提示与独立样式快照，新增 Claude Code + Opus 5.5 的单样本套件、可信视频技术验收与人工评分说明，不预设创作框架（#43）。
- Codex target 支持当前 ChatGPT 订阅登录、显式模型/推理强度与原生模型目录查询，新增 targets init；保留 API provider 与旧记录兼容，订阅费用独立标识为未知，增加认证隔离、超时清理与离线回归覆盖（#42）。
- 任务模板与离线自检 `tasks init/validate`、单一源可信 checker 与文件约束；新增多任务实验套件、整组冻结和全局交错调度，以及兼容旧记录的 Markdown/JSON/CSV 汇总与显式价格文件重算，旧任务和 schemaVersion=1 单题记录继续可用（#41）。
- 新增 DeepSeek Harness / OpenCode V2 两种独立 adapter、四套只读/可写 profiles 及官方 DeepSeek Pro/Flash 四个 targets；显式 Messages/Chat Completions 协议、隔离配置与凭证清理、非交互终态验证、缓存/推理用量归一化与离线测试，未知费用和响应模型保持 null（#40）。
- 多文件修复 `fix-order-total` 与数据整理 `normalize-orders` 任务、明确规格/fixtures、独立验收与反例测试；新增 DeepSeek 官方 Flash 的 Claude Code / Codex targets，支持与 Pro 同任务重复对照（#39）。
- 独立 targets / tasks / harness profiles 与统一执行层，新增 `bench run/ls/show`、配置查询及无密钥 dry-run；接入 Claude Code / Codex，显式协议与 provider 组合，冻结 fixture、独立采样工作区、超时进程回收、命令验收与原始记录/报告；LLM 保留原调用路径（#38）。
- Anthropic 官方 provider 与 Claude Sonnet / Opus / Haiku 5.5 配置、`claude` suite：支持普通/流式对话与多配置对比，校验兼容层无效参数；原生 Messages 正确路由、模型列表原生鉴权与分页；同步密钥示例、文档和离线测试（#37）。
- DeepSeek 官方能力接入：Flash / Pro 四档配置与官方对比组，`run` / `compare` 支持图片、Files 引用、JSON、工具消息与结果续接、前缀续写、附加参数；新增 `api chat|responses|messages|fim` 与 `deepseek search|fetch|files|models|balance`，成功/失败与 SSE 全事件独立落盘，支持无密钥 dry-run。缓存输入价、缓存 usage、响应 model 与高级消息历史兼容旧数据；补跑复用原始附件快照。补充官方 API 指南与离线回归测试（#36）。
- 命名配置 `ds-official-flash` 以及 `ds-official-flash-reason-low` / `ds-official-flash-reason` / `ds-official-flash-reason-max`：走官方 DeepSeek（`providers/deepseek.json`，`https://api.deepseek.com`），模型 `deepseek-flash`；关 thinking 的一路加入 `suites/deepseek`，四档推理强度在 `suites/deepseek-official-flash-effort`。官方 provider 默认模型改为 `deepseek-flash`。

### Changed

- 视频测试提示追加中文字体正常、文字清晰可读及交付前检查实际画面并自行修复的要求，其余设置不变，单次自主复测不干预（#48）。
- 视频测试提示追加必须实际渲染并输出可播放 MP4 的交付要求，保留原文存档、独立样式和其他运行设置，单次自主复测不干预（#46）。
- Harness 从启动时透传设备代理并脱敏认证信息；作品快照与 manifest 验收兼容运行中新建的 Python venv，保持 fixture 链接拒绝与不可变输入保护（#45）。
- 对比汇总表在「配置」后加 `provider` 列，官方 DeepSeek 与 llmcore 同场时一眼能分开。

## [0.5.0] - 2026-09-11

M3 稳健与可发现：网关抽风有重试、有 raw 可查、有 retry 可补；结果有 ls / show 可找；`run` 能流式、能看进度；同请求的路自动合并。

### Added

- `compare --repeat <n>`：每路采样 n 次（总任务 = 路数 × n，与 `--concurrency` 叠加），每次都以 `fromNodeId` 为父。汇总表每路仍一行，耗时 / token / 成本列为 `均值 (最小–最大)`（只算成功次数），错误列 `k/n 失败`；`spec.repeat`、`meta.json.runs`、`variants/<配置>/run-<k>.md` 只在 n > 1 时出现，`output.md` 保留第 1 次。`compare score` 对每次成稿分别算并给均值（`scores.json` 的 `runs`），报表相似度 / 改动率列同样 `均值 (最小–最大)`；`compare retry` 只补跑失败的那几次采样。`--repeat 1` 与不带参数完全一致（#9）。
- `compare ls`（按 createdAt 倒序：c_id、时间、路数 × 次数、session、有无 scores、输入摘要 40 字；空目录友好提示；坏 `spec.json` 跳过并警告到 stderr）、`compare show <c_id>`（与 `report.md` 同一渲染函数的汇总表 + 目录）、`node show <session> <node> [--json]`（turn md 或原始节点 JSON）。找不到会话 / 节点 / 对比时错误信息都带期望路径（#12）。
- `run --stream [--hide-reasoning]`：成稿增量打到 stdout，思维链带 `[reasoning]` 头变暗打到 stderr；落盘节点与非流式同字段、同 usage 口径。不加 `--stream` 且 stderr 是终端时，每 5 秒往 stderr 打一行 `等待 <配置> → <模型>… Ns`，管道里不打（#13）。
- 配置字段 `timeoutMs`（缺省 600000，交给 SDK）与 `maxRetries`（缺省 2，我们这一层指数退避重试，SDK 自身重试关掉）；CLI `--timeout-ms` / `--max-retries`；两项进节点快照，老节点缺字段读成默认值；`config show` 打印。流式一旦开始输出不再重试（#10）。
- 每个节点旁写 `nodes/<id>.raw.json`：请求体（无密钥）、原始响应（流式为拼接后的最终对象 + `chunkCount`）、`systemFingerprint`、像 id 的响应头、失败时的错误序列化；节点与 compare `meta.json` 新增 `requestId`（依次取 `x-request-id` / `x-oneapi-request-id` / `x-keybalancer-request-id` / `request-id` / `cf-ray`），turn md 打印。写盘前把当前 apiKey 打码成 `***`（#11）。
- `compare retry <c_id> [--only a,b] [--concurrency n] [--timeout-ms n] [--max-retries n]`：只补跑失败路（或 `--only` 指定的路），复用原输入 / system / 配置快照，更新对应 `variants/<name>/` 与 `report.md`，删除已失效的 `scores.json` 并提示（#10）。

### Changed

- `run` 的 `新建会话 …` 与 `session=… node=…` 两行以及重试提示从 stdout 移到 stderr，stdout 只剩成稿，`run … > out.md` 不再夹杂元信息（#13）。
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
