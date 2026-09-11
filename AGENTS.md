# AGENTS.md

给各类 coding agent 的仓库说明书。人读 README；你改代码、跑实验、加配置时以本文为准。

文档日期：2026-09-11。

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
src/lib/store.ts      会话 / 对比落盘
src/lib/tree.ts       会话树与分支
src/lib/presets.ts    prompts/system、prompts/user
src/lib/paths.ts      根目录与 data 路径
src/types.ts          类型源
configs/              命名配置
providers/            网关
suites/               预定义对比组
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

```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts config ls
npx tsx src/cli.ts config show ds-v4-flash-reason
npx tsx src/cli.ts compare --suite deepseek-v4-flash-effort --message x --dry-run   # 不发请求，打印配置与请求体 JSON
npx tsx src/cli.ts run --config ds-v4-flash --message '...'
npx tsx src/cli.ts run --config ds-v4-pro-reason --input data/tmp/foo.txt
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

## 配置怎么叠

后者覆盖前者：

1. `providers/<name>.json`：`baseURL`、`apiKeyEnv`、默认模型
2. `configs/<name>.json`：引用 `provider`，再写 `model` / `temperature` / `maxTokens` / `thinking` / `reasoningEffort` / `timeoutMs` / `maxRetries`
3. 没有对应配置文件时，名称当 **模型 id**，走当前或 `--provider`
4. CLI 覆盖：`--provider`、`--temperature`、`--max-tokens`、`--thinking`、`--reasoning-effort`、`--timeout-ms`、`--max-retries`

`thinking` 只有 `enabled` | `disabled`。`reasoningEffort` 只有 `low` | `high` | `max`。V4 开推理 **不是** 新的 model id。

`timeoutMs`（缺省 600000）给 SDK 做单次超时；`maxRetries`（缺省 2）是 `withRetries` 在我们这一层做的指数退避（1s、2s、4s），SDK 的 `maxRetries` 固定 0。两项进快照，老节点缺字段读成默认值；它们不参与 compare 的快照去重。测试里 `makeCommandLab` 的 provider 显式 `maxRetries: 0`，要测重试就在配置里开，并给 deps 传 `retryBaseDelayMs: 0`。

可选 `pricing: { inputPerMillion, outputPerMillion, currency }`（每百万 token，currency 缺省 CNY）可写在 provider 或 config，config 覆盖 provider。配了就有节点 `cost` 与报表「成本」列；没配是 `null` / `-`。价格是数据不是代码，仓库不预置，用户要比性价比时让他自己填；别替他猜价格。

`compare` 注意：

- `--model` **不会**冲掉每一路的模型
- `--thinking` / `--reasoning-effort` **会**作用到所有路
- suite / `--configs` / `--models` 可并用，按名字去重后至少两路；再按解析快照（provider、baseURL、model、thinking、effort、temperature、maxTokens）去重，名字不同但请求相同的路只跑一次并在终端提示（`--configs ds-v4-flash --models deepseek-v4-flash` 只跑一路）
- 各路并行，缺省并发 3；`--concurrency <n>` 必须是 ≥ 1 的整数。报表顺序 = 输入顺序，与谁先完成无关。跑 8 路想最快就 `--concurrency 8`
- 要下「A 比 B 好」的结论先 `--repeat 3`（≥ 1 的整数）：每路 n 次、同一父节点、互不串联；表里 `均值 (最小–最大)` 只算成功的次数。单次结果的排名基本是噪声：实测 flash 三档 effort 各跑 3 次，推理 token 极差是均值的 2–3 倍（low 97 (31–216)、high 32 (25–40)、max 68 (21–160)），`low < high < max` 根本不成立
- `--repeat` 时 `spec.repeat`、`meta.json.runs`、`variants/<配置>/run-<k>.md` 才出现；`--repeat 1` 与不带完全一样。`compare score` 逐次算再取均值（`scores.json` 的 `runs`），裁判只评第 1 次；`compare retry` 只补跑失败的那几次
- 默认 system 预设是 `default`（`prompts/system/default.md`：准确简洁）。测文风时先想清楚要不要换 system

suite 文件形状：`{ "name": "...", "configs": ["a", "b"] }`，放在 `suites/<name>.json`。

现成 suite：`deepseek`、`deepseek-v4-reason`、`deepseek-v4-flash-effort`、`deepseek-v4-pro-effort`。

现成配置（都在 llmcore 上）：

| 配置 | 模型 | thinking | effort |
|---|---|---|---|
| `ds-chat` | deepseek-chat | — | — |
| `ds-v4-flash` / `ds-v4-pro` | v4-flash / v4-pro | disabled | — |
| `ds-v4-*-reason-low` | 同上 | enabled | low |
| `ds-v4-*-reason` | 同上 | enabled | high |
| `ds-v4-*-reason-max` | 同上 | enabled | max（`maxTokens` 16384） |
| `ds-reasoner` | deepseek-reasoner | — | — |

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

节点里：`messages.assistant` 是成稿，`messages.reasoning` 是思维链，`usage.reasoningTokens` 是推理 token，`cost` 是按配置 pricing 算出的花费（没配为 null），`requestId` 是网关响应头里的 request id（llmcore 用 `x-oneapi-request-id`；没有为 null）。`run` 终端只打 assistant；推理看 turn md 或 compare 的 `variants/<配置>/reasoning.md`。

节点旁边的 `nodes/<id>.raw.json` 是原始材料：请求体（无密钥）、原始响应（流式为拼接后的最终对象 + `chunkCount`）、`systemFingerprint`、像 id 的响应头、失败时的 `error` 序列化。要查「effort 有没有进请求体」「网关回了什么字段」读它，别猜。`store.readNodeRaw` 可读；`listNodes` 会跳过 `.raw.json`。写盘经过 `redactSecrets`，当前 apiKey 一律 `***`；节点 `error` 文本也同样打码。

compare 的 `report.md` 不含思维链；开头的汇总表每路一行、行序 = 输入顺序，「成稿 tok」= completion − reasoning（网关的 completion_tokens 含推理）。要看耗时 / token / 错误，读表就够，不用翻正文。

某路失败（网关 5xx、超时）别整组重来：`compare retry <c_id>` 只补跑 `error != null` 的路，复用原 spec 的输入和节点里记录的 system 文本、原节点的配置快照（只允许 `--timeout-ms` / `--max-retries` 覆盖），新节点仍以 `fromNodeId` 为父，旧失败节点留在树里。补跑后 `report.md` 重渲染，`scores.json` 若存在会被删掉并提示重新打分。

`compare score <c_id>` 是离线的：`similarity` 是与 `--reference` 文件的字符级 LCS 比（0–1，没给就是 null），`changeRatio` 是相对输入（或 `--baseline`）的改动比例，`barelyChanged` 表示改动 < 5%。写 `scores.json` 并给汇总表追加两列。它量的是「像不像」，不是「好不好」；「几乎没改」的路先怀疑 thinking 没开。

量「好不好」用 `--judge <config>`：rubric 在 `prompts/judge/<name>.md`（缺省 `default`，变量 `{{input}}` `{{reference}}` `{{candidate}}`），裁判每路一次调用、落到标题 `judge: <c_id>` 的新会话；结果在 `scores.json` 的 `judge` 字段与汇总表「裁判」列。注意：

- 裁判分有噪声，同一裁判两次可差 1–2 分。别拿单次分数下结论
- 裁判偶尔输出非法 JSON（中文引号收尾之类），解析器有兜底；仍失败的路 `judge.error` 有值，其余路照常
- 新 rubric 才进 `prompts/judge/`；一次性的评分说明不要收进去

**不要提交：** `.env`、`data/sessions/**`、`data/comparisons/**`、`data/tmp/` 下除 `.gitkeep` 以外的文件。不要把密钥写进文档、commit message 或对话回复。

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
