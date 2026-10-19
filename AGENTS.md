# AGENTS.md

给各类 coding agent 的仓库说明书。人读 README；你改代码、跑实验、加配置时以本文为准。

文档日期：2026-10-18。

## 这是什么

本地 CLI 实验室：对接 **OpenAI 兼容** 接口，用文件做提示词预设、会话树、分支和多配置对比。

- 交互面只有 CLI，不要加 Web / DB / 后台服务
- 包管理用 **npm**，Node.js >= 20，TypeScript 严格模式
- 默认 provider 是 **llmcore**（`https://proxy.llm-core.cn/v1`）
- 主力实验对象是 DeepSeek V4 flash / pro（同一 model id，靠 `thinking` + `reasoningEffort` 切换推理）
- 忽略仓库里的 `archives/`（如果存在），当它不存在

## 先读再改

```text
src/cli.ts            入口（commander）
src/commands/         子命令
src/lib/config.ts     providers → configs → CLI 叠加
src/lib/client.ts     请求体：thinking、reasoning_effort；回收 reasoning_content
src/lib/chat-options.ts 图片、JSON、工具消息与前缀请求组装
src/lib/official-api.ts 官方多协议、Files、Search/Fetch 的传输与原始记录
src/lib/bench/       独立 targets/tasks、进程 adapter、统一执行/验收/报告
src/lib/store.ts      会话 / 对比落盘
src/lib/tree.ts       会话树与分支
src/lib/presets.ts    prompts/system、prompts/user
src/lib/paths.ts      根目录与 data 路径
src/types.ts          类型源
configs/              命名配置
providers/            网关
harnesses/            执行工具与权限（不绑定 provider）
targets/              直接 LLM 或 harness + backend 实验对象
tasks/                任务、fixtures 与验收条件
suites/               预定义对比组
bench-suites/         多任务实验套件（与 compare 的 suites 独立）
prompts/              可复用预设
data/                 运行产物（多数不进 git）
```

人类用法摘要在 `README.md`。密钥形态只看 `.env.example`，不要读、不要复述 `.env` 里的真实 key。

## 命令

在仓库根目录：

```bash
npx tsx src/cli.ts <命令>
# 等价
npm start -- <命令>
```

不要默认开 `chat`（REPL，要等人）。Agent 跑实验用 `run` / `compare`。

任务实验用 `bench run --task <name> --targets <a,b> [--repeat n] [--concurrency n]`；先加 `--dry-run` 校验快照与进程计划（不需要 key，不启动 CLI，不落盘）。`targets/tasks/harness ls|show` 查定义，`bench ls|show` 查结果。示例 `hello` 测连接，`fix-add` 测文件修复。

扩题使用 `tasks init <name> --template repair|data|answer` 与 `tasks validate <name>|--all`。自检只在临时工作区跑可信本地验收，不调用模型/harness、不加载 .env。旧题无 selfTest 时明确只做结构校验，不假称已验证参考解。新题可用 `kind=script,file=项目内可信mjs`，加载时将源码展开为现有 command argv，完整源码进入快照；参考解/负例不得放入候选 fixture。可选 manifest 的 immutable/editable 和 allowNewFiles 从冻结素材产生断言，禁止运行期回读可修改的 checker。初始状态是否应失败由 selfTest.initial 明确声明。

`bench-suites/<name>.json` 引用 tasks/targets，缺省 repeat=3、concurrency=3；`bench run --suite <name>` 与 `--task/--targets` 互斥。CLI repeat/concurrency/timeout 覆盖套件；时限顺序为 CLI > 套件全局 > 套件单题 > 源任务。新 `--timeout-ms` 同时支持单题，只修改本轮快照。全套件先预检、冻结全部 fixture，再用同一并发池交错执行；不能套件并发再乘子任务并发。新 e_id 父清单引用独立 schemaVersion=1 b_id 子记录，保留顺序和状态；不自动重试或覆盖旧失败。旧 runBenchmark 的默认顺序和单任务语义保持。

`bench report <e_id|b_id...> [--format markdown|json|csv] [--pricing <JSON>] [--scenario <name>] [--output <新文件>]` 是离线读取，不请求、不加载 .env、不改原始记录。报告以冻结 spec 为准，不依赖当前任务/target 源文件；按唯一 b_id/target/sample 去重，计划分母含缺失记录。不同轮次、预算、任务/fixture/target 定义及版本差异不能静默合成排名。套件按任务等权聚合，原生 cost 与估算费用分开；显式价格按 provider/model 精确匹配，reasoning 已含在输出里不重复加。完整 usage 缺失保持未知、缓存分项未知给区间；只有全部尝试可定价且有通过样本时才计算总尝试费/通过数。价格和峰谷由用户维护，禁止猜价。新报告输出拒绝覆盖。

进阶任务：`fix-order-total` 多模块订单修复，`normalize-orders` CSV/客户映射清洗与汇总；两题 timeoutMs=300000。`tasks/checks/<task>.mjs` 是可信验收源，其完整内容内嵌在 task JSON 的 command argv，运行时不从可修改 workspace 加载验收。改 checker 时必须同步内嵌源并跑对应 `tests/bench-task-*.test.ts`；初始 fixture 保持失败，参考解只放测试临时目录。输入/SPEC 的 immutable hash 也必须同步审阅。Flash targets 为 `cc-ds-flash` / `codex-ds-flash` / `dsh-ds-flash` / `opencode-ds-flash`，仍用 deepseek provider，不能换成 llmcore 的模型 id。

```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts config ls
npx tsx src/cli.ts config show ds-v4-flash-reason
npx tsx src/cli.ts compare --suite deepseek-v4-flash-effort --message x --dry-run   # 不发请求，打印配置与请求体 JSON
npx tsx src/cli.ts run --config ds-v4-flash --message '...'
npx tsx src/cli.ts run --config ds-v4-pro-reason --input data/tmp/foo.txt
npx tsx src/cli.ts run --config ds-v4-pro-reason-max --stream --input data/tmp/foo.txt   # 成稿流到 stdout，思维链变暗到 stderr（--hide-reasoning 关）
npx tsx src/cli.ts compare --suite deepseek-v4-flash-effort --input data/tmp/foo.txt
npx tsx src/cli.ts compare --configs ds-v4-flash,ds-v4-pro --message '...'
npx tsx src/cli.ts compare --suite deepseek-v4-pro-effort --input data/tmp/foo.txt --concurrency 8   # 并行路数，缺省 3
npx tsx src/cli.ts compare --suite deepseek-v4-flash-effort --input data/tmp/foo.txt --repeat 3 --concurrency 9   # 每路 3 次，看均值与极差
npx tsx src/cli.ts compare score <c_id> --reference data/tmp/gold.txt   # 离线算相似度 / 改动率，不发请求
npx tsx src/cli.ts compare score <c_id> --reference data/tmp/gold.txt --judge ds-v4-pro-reason --concurrency 8   # LLM 裁判，会发请求
npx tsx src/cli.ts compare retry <c_id> [--only a,b]   # 只补跑失败路；--only 指定的路无论成败都重跑
npx tsx src/cli.ts compare ls                          # 找结果先看这个：倒序、带 session 与有无 scores
npx tsx src/cli.ts compare show <c_id>                 # 只看汇总表，不翻 report.md
npx tsx src/cli.ts node show <session> <node> --json   # 拿原始节点 JSON（可直接 JSON.parse）
npx tsx src/cli.ts session ls
npx tsx src/cli.ts session show <id>
```

改代码后：

```bash
npm test
npm run typecheck
```

单测用 `node:test` + 临时目录（`tests/helpers.ts` 的 `makeLabRoot` / `makeCommandLab`）。测 `run` / `compare` 编排时，用 `tests/fake-completer.ts` 的 `createFakeCompleter` 通过第二个参数 `deps` 注入，不要碰 `runCompletion`。**禁止**在单测里打真实网关 / llmcore。

fixture 与黄金文件：

- `tests/fixtures/<name>/comparison.json` 是脱敏过的真实对比结果（`{ spec, variants }`），用 `tests/fixtures.ts` 的 `loadComparisonFixture` 读。现成的：`polish-8way`（DS V4 flash / pro 八路润色）。
- 要新 fixture：先在本地跑真实 compare，再 `npm run fixture:export -- <c_id> <name>`。脚本会拒绝含 `sk-` / `Bearer` / `.env` 值的内容。
- 渲染测试用 `tests/golden.ts` 的 `assertMatchesGolden(name, text)` 与 `tests/golden/<name>` 逐字节比对。改了渲染格式且确认是预期变化：`npm run test:update-golden`，然后 review diff，在 PR 里说明。不要手改黄金文件。

视频任务 `neural-network-video` 保留用户短提示，仅将样式路径本地化；原文在 tasks/prompts/neural-network-video.original.md，fixture 只含独立样式规范和四张 reference-only PNG，不加入分镜、框架技能或答案。已有 style/** 文件由 manifest 固定 hash，新增输出允许。`cc-opus-5-5` 组合现有可写 Claude Code 与 anthropic provider；`neural-network-video-opus` 套件显式 repeat=1/concurrency=1、执行预算 3600000ms。一次人类指令可包含 harness 内多次工具/模型调用，不自动补跑。可信 checker 用主机 ffprobe 检查候选源码、视频容器/前缀可读帧、正时长和显示方向（竖屏，不限定9:16）；不执行候选代码、不假称验证完整播放或科学/视觉质量。缺 ffprobe 输出基础环境诊断，现有 grade 仍为 failed。人工评分与复现要求见 docs/neural-network-video.md；本题没有参考成片 selfTest，tasks validate 只做结构校验，检查器回归使用假 ffprobe，禁止真实模型调用。

视频提示当前在原短提示后依次追加“必须实际渲染并输出可播放的 MP4，不能只交 HTML 或源码。”和“必须保证中文字体正常、文字清晰可读，交付前检查实际渲染画面并自行修复问题。”；neural-network-video.original.md 保留最初原文，旧实验冻结输入不变。追加不改变 style fixture、框架选择、验收器、权限或预算；保持单次自主执行，字体查找/安装及画面检查由 harness 自行完成，启动后不干预。

## 配置怎么叠

后者覆盖前者：

1. `providers/<name>.json`：`baseURL`、`apiKeyEnv`、默认模型
2. `configs/<name>.json`：引用 `provider`，再写 `model` / `temperature` / `maxTokens` / `thinking` / `reasoningEffort` / `timeoutMs` / `maxRetries`
3. 没有对应配置文件时，名称当 **模型 id**，走当前或 `--provider`
4. CLI 覆盖：`--provider`、`--temperature`、`--max-tokens`、`--thinking`、`--reasoning-effort`、`--timeout-ms`、`--max-retries`

`thinking` 只有 `enabled` | `disabled`。`reasoningEffort` 只有 `low` | `high` | `max`。V4 开推理 **不是** 新的 model id。

`timeoutMs`（缺省 600000）给 SDK 做单次超时；`maxRetries`（缺省 2）是 `withRetries` 在我们这一层做的指数退避（1s、2s、4s），SDK 的 `maxRetries` 固定 0。两项进快照，老节点缺字段读成默认值；它们不参与 compare 的快照去重。测试里 `makeCommandLab` 的 provider 显式 `maxRetries: 0`，要测重试就在配置里开，并给 deps 传 `retryBaseDelayMs: 0`。

可选 `pricing: { inputPerMillion, outputPerMillion, currency }`（每百万 token，currency 缺省 CNY）可写在 provider 或 config，config 覆盖 provider。配了就有节点 `cost` 与报表「成本」列；没配是 `null` / `-`。价格是数据不是代码，仓库不预置，用户要比性价比时让他自己填；别替他猜价格。

`pricing.cachedInputPerMillion` 可选，表示缓存命中输入价。仅命中计数和命中价都有时分开计算；否则沿用统一输入价。usage 可选 `promptCacheHitTokens` / `promptCacheMissTokens`，旧节点无字段则省略。官方峰谷价格涉及法定节假日，由用户选择/维护配置；不硬编码价格、不自动猜峰谷，也不把 Search/Fetch 按次费用冒充 token 成本。

### 官方高级能力

官方能力与完整请求例子见 `docs/deepseek-api.md`。核对日期 2026-10-17：`deepseek-flash` = V4.1-Flash-1017（支持图片），`deepseek-v4-pro` = V4-Pro-0813（纯文本）；两者 1M 上下文、最大输出 384K。旧 Flash 名称已转到新版，不能当作固定旧版本。节点 `responseModel` 保留返回的 model，若仍是别名也不能据此断言实际版本固定。

- `run` / `compare` 支持 `--image <来源...>`（本地图片、URL、data URL）、`--file-id <id...>`、`--json-output`、`--tools <JSON数组文件>`、`--messages <完整消息数组文件>`、`--prefix <文本>`、`--request <附加参数文件>`。
- `--request` 不能覆盖模型/思考/温度/输出上限/stream；消息通过 `--messages` 显式替换。高级消息保留图片、tool_calls、reasoning_content，不缩成字符串。模型工具由调用方执行，禁止自动执行模型生成的 shell。
- 节点 `messages.apiMessages` 是高级请求的完整协议历史 + 本轮实际 assistant；失败时仅保存实际请求消息。前缀续写的历史保存完整 assistant（前缀 + 追加文本），而 stdout 和 `messages.assistant` 保留 API 追加文本。历史中不保留 prefix 标记。
- `spec.request` 保存已解析高级参数及内联图片；`compare retry` 必须复用它，不重新读附件或高级请求文件。
- 官方思考默认 high，temperature/presence_penalty/frequency_penalty 不生效；有 tools 的请求必须完整回传历史 reasoning_content。Flash 的 top_p 仅思考生效且最低 0.95；非思考固定 1。Pro 思考忽略 top_p；非思考可调。
- `api chat|responses|messages|fim --request <文件或内联JSON>` 原样保留完整协议字段，默认 provider 为官方 deepseek；显式 config 使用该配置自己的 provider。高级请求里的显式字段优先于配置缺省值。
- `deepseek search/fetch/files/models/balance` 覆盖官方服务。Files 只有图片上传/列表/元数据/删除，无官方 content 下载接口。Anthropic Files 用 `--anthropic`。
- Responses 无状态，回传完整 input，不依赖 previous_response_id / conversation / store。内置 web_search 只在 Pro 生效，custom 仅支持 apply_patch；CLI 不自动执行它。
- `api` / `deepseek` 单独记录 `data/api/<id>/` 的请求、响应、完整 SSE 事件和错误；所有 dry-run 不要 key、不请求、不落盘。传输通过 deps.fetch 注入，新增单测禁止打真实网关。

新增配置：`ds-official-pro` / `-reason-low` / `-reason` / `-reason-max`；新增 suite：`deepseek-official-pro-effort`、`deepseek-official`。

### Anthropic provider

- 现有 provider 共四个：llmcore / deepseek / openai / anthropic，默认仍 llmcore。Anthropic 地址 `https://api.anthropic.com/v1`、密钥变量 `ANTHROPIC_API_KEY`；不要读取真实 .env，使用 status/config show/dry-run 确认是否已设置。
- `claude-sonnet` / `claude-opus` / `claude-haiku` 分别对应官方 5.5 模型，suite 为 `claude`。默认 temperature=1；不写 pricing 或猜测价格。
- run/chat/compare 使用官方 OpenAI SDK 兼容层；兼容层不返回 thinking，reasoning / reasoningTokens 保持 null，不能当成未思考或 0 token。通用 thinking / reasoningEffort 不映射成 Claude 模型专有模式。
- `src/lib/anthropic.ts` 检查兼容层限制，禁止把 response_format / reasoning_effort / strict / cache_control 等被静默忽略的参数记录为生效。JSON、缓存、原生思考等用 `api messages --provider anthropic --request <JSON>`；路径是 `/v1/messages`，不能误拼 DeepSeek 的 `/anthropic/v1/messages`。
- 原始 Messages 请求中的显式 thinking / output_config 等字段优先，不套用 DeepSeek 的模型规则；Sonnet/Opus/Haiku 对关闭思考的支持不同，按官方模型文档构造，不猜。
- `src/lib/provider-models.ts` 负责模型列表：Anthropic 用原生 x-api-key / anthropic-version，has_more + last_id/after_id 分页；其他 provider 沿用兼容列表。模型列表和网络测试通过 deps.fetch/本地假 HTTP 离线验证。

`compare` 注意：

- `--model` **不会**冲掉每一路的模型
- `--thinking` / `--reasoning-effort` **会**作用到所有路
- suite / `--configs` / `--models` 可并用，按名字去重后至少两路；再按解析快照（provider、baseURL、model、thinking、effort、temperature、maxTokens）去重，名字不同但请求相同的路只跑一次并在终端提示（`--configs ds-v4-flash --models deepseek-v4-flash` 只跑一路）
- 各路并行，缺省并发 3；`--concurrency <n>` 必须是 ≥ 1 的整数。报表顺序 = 输入顺序，与谁先完成无关。跑 8 路想最快就 `--concurrency 8`
- 要下「A 比 B 好」的结论先 `--repeat 3`（≥ 1 的整数）：每路 n 次、同一父节点、互不串联；表里 `均值 (最小–最大)` 只算成功的次数。单次结果的排名基本是噪声：实测 flash 三档 effort 各跑 3 次，推理 token 极差是均值的 2–3 倍（low 97 (31–216)、high 32 (25–40)、max 68 (21–160)），`low < high < max` 根本不成立
- `--repeat` 时 `spec.repeat`、`meta.json.runs`、`variants/<配置>/run-<k>.md` 才出现；`--repeat 1` 与不带完全一样。`compare score` 逐次算再取均值（`scores.json` 的 `runs`），裁判只评第 1 次；`compare retry` 只补跑失败的那几次
- 默认 system 预设是 `default`（`prompts/system/default.md`：准确简洁）。测文风时先想清楚要不要换 system

suite 文件形状：`{ "name": "...", "configs": ["a", "b"] }`，放在 `suites/<name>.json`。

现成 suite：`deepseek`、`deepseek-v4-reason`、`deepseek-v4-flash-effort`、`deepseek-v4-pro-effort`、`deepseek-official-flash-effort`。

现成配置：

| 配置 | provider | 模型 | thinking | effort |
|---|---|---|---|---|
| `ds-chat` | llmcore | deepseek-chat | — | — |
| `ds-v4-flash` / `ds-v4-pro` | llmcore | v4-flash / v4-pro | disabled | — |
| `ds-official-flash` | deepseek（官方） | deepseek-flash | disabled | — |
| `ds-official-flash-reason-low` | deepseek（官方） | deepseek-flash | enabled | low |
| `ds-official-flash-reason` | deepseek（官方） | deepseek-flash | enabled | high |
| `ds-official-flash-reason-max` | deepseek（官方） | deepseek-flash | enabled | max（`maxTokens` 16384） |
| `ds-v4-*-reason-low` | llmcore | 同上 v4 | enabled | low |
| `ds-v4-*-reason` | llmcore | 同上 v4 | enabled | high |
| `ds-v4-*-reason-max` | llmcore | 同上 v4 | enabled | max（`maxTokens` 16384） |
| `ds-reasoner` | llmcore | deepseek-reasoner | — | — |

加新配置：在 `configs/` 写 JSON，`name` 与文件名（去 `.json`）一致。不要把密钥写进 JSON。

## 提示词与临时输入

- 可复用的才进 `prompts/system/<name>.md`、`prompts/user/<name>.md`、`prompts/judge/<name>.md`
- user 预设可用 `{{input}}`。没有占位符时：`run` / `compare` 把预设当完整 user 消息
- **一次性草稿**放 `data/tmp/`，例如 `--input data/tmp/polish-post.txt`
- 不要把一次性帖子/提示词收进 `prompts/`，除非用户明确要求

## 落盘与 git

```text
data/sessions/<s_id>/          会话树、节点 JSON、turn md
data/comparisons/<c_id>/       spec.json、report.md（汇总表 + Input + 各路成稿）
  variants/<配置>/             meta.json、output.md（成稿）、reasoning.md（思维链，没有就不生成）
data/tmp/                      一次性输入
```

节点里：`messages.assistant` 是成稿，`messages.reasoning` 是思维链，`usage.reasoningTokens` 是推理 token，`cost` 是按配置 pricing 算出的花费（没配为 null），`requestId` 是网关响应头里的 request id（llmcore 用 `x-oneapi-request-id`；没有为 null）。`run` 的 stdout 只有 assistant（会话行、重试提示、进度、`--stream` 的思维链都在 stderr，`2>/dev/null` 就只剩成稿）；推理看 turn md、`node show`、compare 的 `variants/<配置>/reasoning.md`，或 `run --stream` 时直接看 stderr。等网关时 stderr 是终端才打进度，你在管道里跑看不到是正常的。

节点旁边的 `nodes/<id>.raw.json` 是原始材料：请求体（无密钥）、原始响应（流式为拼接后的最终对象 + `chunkCount`）、`systemFingerprint`、像 id 的响应头、失败时的 `error` 序列化。要查「effort 有没有进请求体」「网关回了什么字段」读它，别猜。`store.readNodeRaw` 可读；`listNodes` 会跳过 `.raw.json`。写盘经过 `redactSecrets`，当前 apiKey 一律 `***`；节点 `error` 文本也同样打码。

compare 的 `report.md` 不含思维链；开头的汇总表每路一行、行序 = 输入顺序，第二列是 `provider`（官方 DeepSeek 是 `deepseek`，中转是 `llmcore`），「成稿 tok」= completion − reasoning（网关的 completion_tokens 含推理）。要看耗时 / token / 错误，读表就够，不用翻正文。

某路失败（网关 5xx、超时）别整组重来：`compare retry <c_id>` 只补跑 `error != null` 的路，复用原 spec 的输入和节点里记录的 system 文本、原节点的配置快照（只允许 `--timeout-ms` / `--max-retries` 覆盖），新节点仍以 `fromNodeId` 为父，旧失败节点留在树里。补跑后 `report.md` 重渲染，`scores.json` 若存在会被删掉并提示重新打分。

`compare score <c_id>` 是离线的：`similarity` 是与 `--reference` 文件的字符级 LCS 比（0–1，没给就是 null），`changeRatio` 是相对输入（或 `--baseline`）的改动比例，`barelyChanged` 表示改动 < 5%。写 `scores.json` 并给汇总表追加两列。它量的是「像不像」，不是「好不好」；「几乎没改」的路先怀疑 thinking 没开。

量「好不好」用 `--judge <config>`：rubric 在 `prompts/judge/<name>.md`（缺省 `default`，变量 `{{input}}` `{{reference}}` `{{candidate}}`），裁判每路一次调用、落到标题 `judge: <c_id>` 的新会话；结果在 `scores.json` 的 `judge` 字段与汇总表「裁判」列。注意：

- 裁判分有噪声，同一裁判两次可差 1–2 分。别拿单次分数下结论
- 裁判偶尔输出非法 JSON（中文引号收尾之类），解析器有兜底；仍失败的路 `judge.error` 有值，其余路照常
- 新 rubric 才进 `prompts/judge/`；一次性的评分说明不要收进去

**不要提交：** `.env`、`data/sessions/**`、`data/comparisons/**`、`data/api/**`、`data/benchmarks/**`、`data/tmp/` 下除 `.gitkeep` 以外的文件。不要把密钥写进文档、commit message 或对话回复。

`bench` 的 schemaVersion=1，`spec.json` 固定任务、解析后 targets 和 fixture hash；`fixture/` 冻结源，每个 `variants/<target>/run-<n>/` 独立 workspace/home、record.json、output.md、events.jsonl、stdout.log、stderr.log、changes.json。执行状态与 grade 状态不可混同；usage/cost 未知保持 null，总费用来源必须标明。当前不提供 bench retry，不自动重跑有副作用的整个任务。

执行进程白名单继承 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 及小写形式，显式进程环境优先；不因此继承其他 provider 凭证。带认证代理的 URL 与凭证片段须走 executionSecrets 脱敏。fixture 冻结/复制仍严格拒绝符号链接；仅最终候选快照与 manifest 检查排除运行中新建的真实 .venv/venv 目录，目录自身不能是链接，冻结素材已有的同名路径不能被排除。原视频提示测试自主安装能力时，运行前固定代理、认证和实际权限；启动后只读观察，不修环境、不停止子进程、不追加提示。

Harness 与 provider 独立：`harnesses/` 只描述 adapter/executable/permission，`targets/` 显式组合 backend。现有五种 adapter，标准只读/可写 profile 共十套，另有下文两套视频专用 profile：`claude-code` / `claude-code-write`、`codex` / `codex-write`、`deepseek-harness` / `deepseek-harness-write`、`opencode` / `opencode-write`、`cursor-agent` / `cursor-agent-write`。LLM provider 仍为四个。使用 provider API backend 时，Claude Code / DeepSeek Harness 需要 `anthropic-messages`，Codex 需要 `responses`，OpenCode 需要 `chat-completions`。provider 必须在 `endpoints` 声明协议地址，不推断品牌、不隐式搭桥。Messages endpoint 为原生根（例如 `/anthropic`），Responses/Chat Completions 为 API 前缀（例如 `/v1`）。provider backend 默认继续使用 API key。Codex 支持显式 backend.auth=chatgpt，Claude Code 支持 backend.auth=claude-subscription，复用各自原生订阅登录，详见下段。Cursor 使用自己的原生服务，不能组合 DeepSeek 等 LLM provider。新增 `dsh-ds-pro` / `dsh-ds-flash`、`opencode-ds-pro` / `opencode-ds-flash` 均组合官方 deepseek provider。

Cursor Agent target 的 backend 为 `{auth:"cursor-login",model}` 或 `{auth:"cursor-api-key",model,apiKeyEnv?}`，只供 cursor-agent adapter，拒绝 provider/protocol/baseURL/pricing、认证目录及其他 harness 的推理参数。API key 环境变量缺省 CURSOR_API_KEY；它是 Cursor 原生 key，不是 LLM provider 凭证。预置 cursor-auto / cursor-api-auto 均用可写 profile 和原生 auto 模型，不能当作固定模型版本。`targets init name --harness cursor-agent-write --auth cursor-login|cursor-api-key --model ID [--api-key-env NAME]` 写新文件；默认 Codex 创建行为不变。`harness cursor-agent status|models`（alias cursor）支持 --auth / --api-key-env / --json，只输出安全元数据；查询不加载 .env，key 须预先在进程环境设置。状态区分凭据存在与原生验证，不判断订阅权益；动态模型目录也不是权益保证。

Cursor 适配锁定源码核对版本 2026.07.23-e383d2b，CLI 独立安装，不增加项目运行时依赖。cursor-login 当前仅支持 macOS，由原生 Cursor 使用固定 Keychain 身份，隔离 HOME/config/data，不解析、复制、导出凭据，不用配置目录选择账号；Linux 可用 cursor-api-key，原生内存凭据存储不持久化 key，执行包装器要求 POSIX。不自动 login/logout 或回退认证。任务用 -p / stream-json / 显式 model / sandbox enabled，只读增加 mode=ask，两套 profile 都用明确工具白名单；仅 trust 本轮冻结素材建立的专属 workspace，不使用 force/yolo，不自动批准 MCP。全量预检及执行时拒绝 workspace 内 .cursor 配置；本地个人配置隔离，但远端 account/team plugins、hooks、managed skills 仍可能由原生加载，不宣称全部个人扩展已禁用或不同 harness 条件完全一致。dry-run 不启动 CLI、不读认证。

Cursor shell 使用只读可信 bash/zsh 包装器，清除 key/token/secret/password/credential 及非标准 proxy 环境，但保留八个标准 HTTP/HTTPS/ALL/NO_PROXY 大小写变量并跳过用户 rc。禁止配置 Shell(*)：该原生版本会将显式放行 shell 升级为 insecure_none；应由 sandbox 策略预批准范围内命令。全局 readBoundary 未完整合并，文件读取工具不受 shell 沙箱统一约束，不承诺只读 workspace；native hooks/plugins/直接子进程不经过包装器。

Cursor 的 token 事件可能缺省补零、遗漏重试或缺少完整推理口径，统一 usage/usageSource/cost/costSource 全为 null，原始 usage 事件保留供审计；init model 只是展示标签，responseModel 为 null。报告 auth 为 cursor-login/cursor-api-key、provider=null，不应用 LLM API 价格，不把未知费用当免费；不能用原始字段绕过完整性限制。2026-10-18 已补真实运行诊断：隔离 HOME/PATH 会影响本机原生登录；全权限视频实验的单次包装器保留原生 HOME/PATH，不读取或复制凭据，配置与数据目录仍独立。通用隔离 profile 不因此放宽。

Codex 订阅 target 的 backend 为 `{auth:"chatgpt",model,reasoningEffort?,codexHome?,credentialsStore?}`，不含 provider/protocol/baseURL/apiKeyEnv/pricing；仅 Codex 接受。旧 backend 缺 auth 时仍是 API key，新增 API auth=api-key 可显式写出。Codex reasoningEffort 原样传 model_reasoning_effort（none/minimal/low/medium/high/xhigh/max/ultra），模型实际支持值由原生目录/执行验证，不映射 DeepSeek thinking。`harness codex status|models [--json] [--codex-home path] [--credentials-store auto|file|keyring]` 读取安全元数据；`targets init name --auth chatgpt --model ID [--reasoning-effort medium] [--harness codex-write]` 创建新定义，不覆盖；API 创建传 --auth api-key --provider name。不自动选择/替换模型。预置 codex-chatgpt 使用 gpt-6.1-sol / low（2026-10-18 本机目录默认值）。

订阅认证目录解析为当前 CODEX_HOME 或 ~/.codex（可显式配置），原生凭据存储缺省 auto。仅 Codex 原生读取认证，不直接解析/复制/落盘 auth.json 或导出 keyring。运行前原生 codex login status 必须确认 ChatGPT，其他模式失败且不自动 login/logout，不使用可能改变登录的 forced_login_method。执行保持隔离 HOME/workspace，复用原生 CODEX_HOME，使用 ignore-user-config/ignore-rules/ephemeral/no-daemon，禁 host skills/插件/hooks/apps/MCP/子 agent/web search，日志与 SQLite 重定向本轮目录；共享认证可能被 Codex 原生刷新。订阅工具权限使用 default_permissions 命名 profile，继承 :workspace / :read-only 并以 inline TOML filesystem 表 deny 认证目录；不可同时传会覆盖该 profile 的 --sandbox；带引号的路径不可塞进 -c 点分 key。元数据 app-server 无 ignore-user-config，会经过原生配置加载，显式官方路由与禁扩展；只读取登录类型/模型目录（未报告的 planType 保持 null），身份/token/原始诊断不返回，短进程回收后删除临时目录。模型目录可能缓存，不等于实际账号权限。dry-run 不启动进程、不读认证。认证检查计入任务预算，所有相关单测注入假进程，不能请求真实模型。订阅费用保持 null，不用 API 单价计费或算作免费；报告 auth=chatgpt/provider=null，纯 API 旧格式保持兼容。

Claude Code 订阅 target 的 backend 为 `{auth:"claude-subscription",model,claudeConfigDir?}`，仅 Claude Code 接受；禁止 provider/protocol/baseURL/apiKeyEnv/pricing/codexHome/credentialsStore/reasoningEffort。`targets init name --harness claude-code-write --auth claude-subscription --model opus [--claude-config-dir path]` 创建新文件；可选完整模型 ID，预置 cc-claude-sonnet / cc-claude-opus 的 sonnet/opus 是原生别名，不能视为固定版本。`harness claude-code status [--json] [--claude-config-dir path]` 只返回白名单认证元数据。Claude API target 仍通过 --auth api-key --provider name 创建，协议 anthropic-messages；旧 target/记录不迁移。Codex 的 targets init 默认值继续保留。

Claude 目录解析顺序为显式字段（相对项目根规范化）> 当前 CLAUDE_CONFIG_DIR > ~/.claude；环境值要求绝对路径，必须保留其原字符串拼写/尾斜线以匹配 native hash，不能擅自 resolve 改写。目录与 claudeConfigDirMode=default|explicit 冻结进本轮快照，mode 不属于源字段。macOS 原生 Keychain 区分显式目录命名空间，不可将默认 ~/.claude 改成显式同路径。default 保留原 HOME 且不传 CLAUDE_CONFIG_DIR；explicit 使用隔离 HOME 并传冻结目录。仅原生读取/刷新认证，不解析、复制、导出或另存凭据；共享原生状态可能被刷新，不假称完全隔离。任务执行门控要求 Claude Code >=2.1.296，独立状态查询目录元数据最低2.1.268；执行前 loggedIn=true、authMethod=claude.ai、apiProvider=firstParty、configDirectory 一致才能继续。缺字段、未知认证或路径不匹配均失败，不自动登录/登出，不回退 API key。认证检查计入任务预算，dry-run 不启动 CLI/读认证。

Claude 订阅启动用 safe-mode/restricted、显式权限和空 MCP，禁个人定制；不得加关闭 OAuth 的 bare。default 模式的原生 shell 快照会读取原 HOME 下的绝对 rc，可信 claude-shell.ts 包装器用 macOS sandbox-exec 禁读这些路径，shell 使用临时 HOME 和 --noprofile/--norc；非 macOS 无此默认模式隔离时必须失败，提示在独立显式 CLAUDE_CONFIG_DIR 内先原生登录。包装器/沙箱配置/可信 settings 放在本轮 home，原生工具策略拒绝模型写入，机器管理策略继续生效；不能宣称单靠 HOME 或工具权限就是完整 OS 隔离。订阅 execution.cost / costSource 均为 null，不把 total_cost_usd 当订阅实费，也不应用 API 价格；报告 auth=claude-subscription/provider=null。2026-10-18 本次实现按用户要求只做静态类型检查与代码审阅，不运行测试、status、dry-run 或 bench，不宣称已验证当前登录/模型权限/运行时隔离。

DeepSeek Harness adapter 基于官方 npm `@deepseek-ai/dsh@0.2.0-rc.2`：`dsh --profile headless --patch <文件> --json -`，只装载两个官方 base/headless bundles；独立 HOME/DSH_HOME，禁遥测/OTel、个人指令、skills、插件管理、附加模型路由及委派。它使用自身原生 DeepSeek Messages adapter，内部注册名 `deepseek-official`，我们的 provider 仍独立；请求带 `thinking` / `output_config` 扩展，不能把任意 Anthropic 模型都认定为兼容。成功必须有 session、completed turn_end、final 和 exit 0；final 后事件或重复终态拒绝。step_end usage 已含重试尝试，逐步汇总；inputTokens 不含 cacheRead/cacheWrite，prompt 必须加回两者，reasoning 不重复加到 output。任一步 usage 不全则总 usage 为 null。

OpenCode adapter 基于官方 npm `@opencode/cli@2.0.32` 的 V2；版本检查拒绝 V1。`run --standalone` 使用本次临时 `serve --stdio`，退出时清理，无常驻服务。独立 HOME/XDG/配置目录，禁用户/项目配置、自动更新、models fetch、skills/MCP/不相关插件；唯一显式允许的可信本地插件用 undefined tombstone 清除 shell 环境中的 key/token/secret/password 和 OPENCODE_CONFIG_CONTENT，防止上游环境合并复活凭据。机器管理 policy 仍按上游规则生效，不绕过。工具权限与外部目录规则不等于 OS 沙箱。V2 快速响应可能漏发最终 step_finish，正常主进程后必须用官方 `session export --standalone` 无凭据后验：session/prompt/workspace/backend 匹配、原生 succeeded/idle 与最终 assistant.stop/completed；不能仅凭 exit 0 或文本成功，原流硬错误不可恢复。后验共享任务剩余预算，失败/超时不验收。用量以导出累计 tokens 为准，不再叠加原流步骤；prompt=input+cache.read+cache.write，completion=output+reasoning，缺计数或委派则 null。新两个 adapter 的 cost/responseModel 未知均为 null，不把 OpenCode 合成的零价格当成免费。CLI 独立安装，不新增项目运行时依赖；所有版本探测不带 API key。

`src/lib/bench/executor.ts` 统一执行：直接 LLM 注入 `ExecutorDeps.complete`，harness 注入 `ExecutorDeps.runProcess`；命令编排可传 `BenchCommandDeps`。单测不得启动真实 harness 或网关，process 测试只运行本地假进程；进程 runner 用无 shell argv、干净环境、输出上限、超时进程组回收。LLM task 时限覆盖退避/请求，harness task 时限覆盖版本检查/执行；各验收命令另有时限。DSH/OpenCode/Cursor 执行的 ProcessRequest.terminationGraceMs=4000，留出原生子进程清理时间（DSH/OpenCode 原生约三秒），其余默认 200ms；时限触发后先清理再返回。不得在进程终止回收前验收或写最后快照。不要修改父进程的 HOME/CODEX_HOME/DSH_HOME 等环境变量。

fixture 必须在项目内，复制时跳过 .env/.env.*（保留 .env.example）、.git、node_modules、archives，拒绝 symlink；不自动读真实项目或用户设置。验收命令来自可信 task 定义，注意不要让 agent 可修改的脚本充当唯一评分标准。新渲染格式通过 golden 工具生成并 review。

用户没说「提交 / 同步」就不要 `git commit` / `git push`。

## 工程流程

改动走 GitHub，不直接推 `master`（分支保护已开：必须走 PR，CI 不绿合不进）。

1. **先有 issue。** 用「任务」模板，验收标准写成 checklist，每条能被人或测试独立判真假。写不出验收标准的需求不开工。
2. **里程碑顺序：** M0 地基 → M1 并行与报表 → M2 评估与成本 → M3 稳健与可发现。M0 未合并前不开功能 PR。M2 与 M3 内部可并行。
3. **一个 issue 一个分支一个 PR。** 分支名 `feat/<issue号>-<短名>`、`fix/...`、`chore/...`。PR 标题 `type(area): 一句话`，正文用模板，写 `Closes #<n>`。
4. **CI 自动跑** typecheck、test、离线冒烟。CI 里没有真实 key，也不允许打网关。
5. **带 `needs-live-check` 的 PR**，还要人在本地打一次真实网关，把 `c_id` 和汇总表贴进 PR。不贴证据不合并。
6. **改了渲染** 就更新 `tests/golden/` 并在 PR 里说明；**改了 CLI 行为或落盘格式** 就同步 README 与本文；每个 PR 在 `CHANGELOG.md` 的 Unreleased 加一行。
7. **squash 合并**，删分支。每完成一个里程碑：升版本、打 tag、发 Release，Release notes 从 CHANGELOG 拷。

## 改代码时

- 严格模式已开：`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`noUncheckedIndexedAccess`
- 类型用 `import type`；本地 TS 模块带 `.ts` 后缀
- 可选字段：不要赋 `undefined`，该缺就省略 key
- 配置解析、落盘、渲染的逻辑放 `src/lib/`，命令层只做编排
- 保持 CLI 为唯一界面；不要引入新的运行时依赖，除非用户要
- 用户规则若要求写文档先取日期：在 macOS 上用 `date`，不要猜

技术债与红线：

- 类型绕过（`as never` / `as unknown as`）全仓库只允许一处：`src/lib/client.ts` 的 `toSdkParams`，原因写在它的 JSDoc 里（请求体带 SDK 类型没有的 `thinking` 字段）。`tests/hygiene.test.ts` 会数这个，别在别处再加
- SDK 响应用 SDK 自己的类型（`ChatCompletion` / `ChatCompletionChunk`）；网关扩展字段（`reasoning_content` 等）走 `readStringField` 之类的宽松读取，不要再整个 `as` 掉

## 常见坑

- 关 thinking 的 flash 可能几乎不改稿；要比文风先开 reasoning
- llmcore 不保证 `low < high < max` 的推理长度
- `compare --suite x --model y` 不会把各路都换成 y
- 缺密钥时先 `status` / `config show` / `--dry-run`，不要把 `.env` 内容贴出来
- 想确认 `thinking` / `reasoning_effort` 是否真进了请求体，用 `--dry-run` 看 `request` 字段，别猜
- 测网关用 CLI；回归用 `npm test`，两套不要混

Cursor harness profile 可选 `useHttp1ForAgent: boolean`（仅 Cursor 支持），写入原生 `network.useHttp1ForAgent` 并进入快照；预置两套 Cursor profile 显式开启 HTTP/1.1 SSE。旧 profile 缺省字段保持原生默认，不重写历史实验。Cursor 进程设置 `NODE_USE_ENV_PROXY=1`，代理仍走标准环境白名单与脱敏；不关闭 TLS 校验。已移除服务端可能拒绝的 `--exclude-workspace-context`，因此原生可能加载父仓库/本机上下文，不能宣称完全隔离。

Cursor profile 另可选 `nativeStallTimeoutMs`（30000–300000 整数），预置为 300000。`cursor-runtime.ts` 只对固定版本与完整 SHA-256 相符的官方入口，在内存中替换原生 stall 默认值；它不是官方配置项，不修改安装，不改变任务总时限、模型、图片或权限。补丁 ID/hash/等待时间和 preload 内容进入 plan 与 home/cursor-runtime/compatibility.json；旧定义缺省时不打补丁。校验失败必须拒绝启动，不能默默降级或伪造版本。元数据/版本探针不得继承此 preload；原生入口运行前移除其 NODE_OPTIONS，工具子进程不能继承。原生 bash launcher 由绝对系统 bash 启动，避免先进入工具 shell 包装器并清掉认证/preload；后续工具 shell 的隔离规则不变。

Cursor profile 的 `useCurrentUserHomeForLogin: boolean` 只供 Cursor；预置 true，旧定义缺省 false。只有 cursor-login 原生进程保留当前用户 HOME/USERPROFILE；metadata 与实际执行必须采用同一规则，API key/memory 与版本探针仍用隔离 HOME。配置/data/XDG/cache/工具 shell 保持每轮独立，不解析或复制认证文件。原生可能读取本机上下文，文档/快照不得冒充全 HOME 隔离；正式视频的完整权限设置独立记录。


### 视频执行配置与报告附件（2026-10-19）

新增 `claude-code-video` / `cursor-agent-video` 两套专用完整权限 profile（普通十套不变）。`HarnessProfile.execution` 可选 fullAccess/proxy/maxOutputBytes/pinModelAliases；缺省保持旧行为。fullAccess 仅支持可写 Claude API/Cursor，不扩展订阅隔离；完整权限可越过工作区。proxy 为 inherit 或 Claude 专用 claude-shell，后者生成私有 CLAUDE_ENV_FILE；含引号代理凭据同样脱敏。日志范围 1024–134217728，视频 128 MiB，缺省 16 MiB。所有变更在 planHarness 内生效，不再通过临时 runner 偷改 argv/settings。三个 `neural-network-video-{flash,opus,cursor}-full` 套件显式 3600000ms/repeat1/concurrency1。旧提示、fixture、套件、记录不变。Cursor 完整权限保留本机 PATH/原生 shell，不能宣称普通 profile 的工具 shell 隔离仍适用。

`bench review-template <b_id> --output <新JSON>` 离线生成 schemaVersion=1 entries，绑定 spec.json/record.json 字节 SHA-256。`bench report --review <JSON>` 验证归属、唯一性、指纹、评分与用量，拒绝陈旧或无证据的已评审附件；不读候选证据路径、不改记录、不加载 .env。人工 verdict/score 与 grade 独立，method 必须区分 human/agent-assisted，未知维度不打分。usageAlternatives 在统一报告中按显式 pricing/scenario 分别估算，不替换原始 usage 或混入主汇总；Cursor 附件禁止提供核对用量，订阅仍禁止套 API 价。JSON 带附件快照和 SHA，Markdown 独立章节，CSV 可选 JSON 列；缺附件/执行扩展时旧渲染保持兼容。详见 docs/video-experiments.md。
