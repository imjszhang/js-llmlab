# js-llmlab

[![ci](https://github.com/imjszhang/js-llmlab/actions/workflows/ci.yml/badge.svg)](https://github.com/imjszhang/js-llmlab/actions/workflows/ci.yml)

本地 CLI 实验室：对接 OpenAI 兼容接口。`.env` 只放各 provider 的密钥；`providers/` 描述网关；`configs/` 描述要测的模型/参数。用文件保存预设、会话树、分支和对比结果。

创建日期：2026-09-11。文档更新：2026-09-11。

## 要求

- Node.js >= 20
- npm

## 安装

```bash
cd /Users/jszhang/github/my/js-llmlab
npm install
cp .env.example .env
```

编辑 `.env`，给要用的 provider 填密钥：

```bash
JS_LLMLAB_PROVIDER=llmcore
LLMCORE_API_KEY=sk-...
# OPENAI_API_KEY=
# DEEPSEEK_API_KEY=
```

```bash
npx tsx src/cli.ts status
npx tsx src/cli.ts provider ls
npx tsx src/cli.ts models --provider llmcore
```

## 配置分层

后者覆盖前者：

1. `providers/<name>.json`：网关的 `baseURL`、`apiKeyEnv`、默认模型
2. `configs/<name>.json`：引用 `provider`，再覆盖 `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxRetries`
3. 没有配置文件时，名称当作模型 id，走当前或 `--provider` 指定的网关
4. CLI：`--provider`、`--temperature`、`--max-tokens`、`--timeout-ms`、`--max-retries`（`compare` 不会用 `--model` 冲掉每一路）

`timeoutMs`（缺省 600000）交给 SDK 做单次请求超时；`maxRetries`（缺省 2）是我们这一层的指数退避重试（1s、2s、4s…），SDK 自身的重试已关掉，不会双重重试。流式一旦开始输出就不再重试。两项都进节点快照，`config show` 会打出来。

当前主力是 **llmcore**（`https://proxy.llm-core.cn/v1`）。另外预置了 `openai`、`deepseek` 官方入口，填对应密钥即可用。

主测四套（都在 llmcore 上）：三套 Chat，外加一套推理。

- `ds-chat` → `deepseek-chat`
- `ds-v4-flash` → `deepseek-v4-flash`（thinking 关闭）
- `ds-v4-pro` → `deepseek-v4-pro`（thinking 关闭）
- `ds-v4-flash-reason` / `ds-v4-pro-reason` → thinking 开启，`reasoningEffort=high`
- `ds-v4-flash-reason-low` / `-max`、`ds-v4-pro-reason-low` / `-max` → 同一模型换推理强度
- `ds-reasoner` → `deepseek-reasoner`

推理强度可写在配置文件的 `reasoningEffort`（`low` / `high` / `max`），或命令行 `--reasoning-effort`。

预定义对比组：`suites/deepseek.json`，`suites/deepseek-v4-reason.json`，以及 `deepseek-v4-flash-effort` / `deepseek-v4-pro-effort`。

```bash
js-llmlab compare --suite deepseek --message '用一句话解释注意力'
```

落盘快照含 `provider` / `name` / `baseURL` / `model` / `temperature` / `maxTokens`，不含 API Key。

### 价格与成本

在 `providers/<name>.json` 或 `configs/<name>.json` 里加可选的 `pricing`（config 覆盖 provider，只写 provider 也生效）：

```json
{
  "pricing": { "inputPerMillion": 1, "outputPerMillion": 4, "currency": "CNY" }
}
```

单位是每百万 token，`currency` 缺省 `CNY`。配了之后每个节点多一个 `cost: { input, output, total, currency }`，turn md、`report.md` 汇总表与 `compare` 终端输出多一列「成本」；没配就是 `null` / `-`，不会算成 0。推理 token 按 OpenAI 兼容口径已含在 `completion_tokens` 里，按 output 价计，不重复计。`config show <name>` 会打出当前生效的 pricing。

价格自己填、自己维护，仓库不预置；**网关实际计费以账单为准**，这里只用来横向比性价比。

## 命令

```bash
js-llmlab status
js-llmlab provider ls
js-llmlab provider show llmcore
js-llmlab models [--provider llmcore]
js-llmlab config ls
js-llmlab config show ds-chat
js-llmlab chat [--provider llmcore] [--config ds-chat]
js-llmlab run --config ds-chat --message text
js-llmlab run --config ds-v4-flash-reason --message text --dry-run   # 只打印配置与请求体，不发请求
js-llmlab run --config ds-v4-pro-reason-max --stream --input data/tmp/foo.txt   # 成稿边收边打；思维链变暗打到 stderr，--hide-reasoning 关掉
js-llmlab compare --suite deepseek --message text
js-llmlab compare --suite deepseek-v4-pro-effort --input data/tmp/foo.txt --concurrency 8   # 各路并行，缺省并发 3
js-llmlab compare --suite deepseek-v4-flash-effort --input data/tmp/foo.txt --repeat 3   # 每路采样 3 次，表里是 均值 (最小–最大)
js-llmlab compare score <c_id> --reference data/tmp/gold.txt   # 对已有对比算相似度 / 改动率，不发请求
js-llmlab compare score <c_id> --reference data/tmp/gold.txt --judge ds-v4-pro-reason   # 再让 LLM 裁判逐路打 0–10 分
js-llmlab compare retry <c_id> [--only a,b]   # 只补跑失败的路（或指定的路），更新 variant 与 report.md
js-llmlab compare --provider llmcore --models deepseek-chat,deepseek-v4-flash,deepseek-v4-pro --message text
js-llmlab compare ls                # 按时间倒序列出对比：c_id、时间、路数、session、有无 scores、输入摘要
js-llmlab compare show <c_id>       # 打印与 report.md 相同的汇总表和目录
js-llmlab session ls
js-llmlab session show <id>
js-llmlab node show <session> <node> [--json]   # 打印一个节点的 turn md；--json 打原始节点 JSON
js-llmlab branch create --session id --name alt [--from node]
```

`run` / `compare` 加 `--dry-run` 时输出一段 JSON：解析后的配置快照、密钥变量名与是否已设置、messages、将发送的请求体。不需要 key，不建会话，不写 `data/`。

`run` 的 stdout 只有成稿，方便 `> out.md` 或接管道；`新建会话 …`、`session=… node=…`、重试提示、进度都走 stderr。不加 `--stream` 时，如果 stderr 是终端，每 5 秒打一行 `等待 <配置> → <模型>… Ns`，管道里不打。加 `--stream` 时成稿一段段打到 stdout，思维链变暗打到 stderr（`--hide-reasoning` 关掉）；两种方式落盘的节点字段与 usage 口径一样。

`compare` 的各路先按名字去重，再按解析后的快照去重：`--configs ds-v4-flash --models deepseek-v4-flash` 两个名字落到同一个请求，只跑一路，终端会提示被跳过的名字。只差 effort / temperature 等参数的路不会被合并。

`chat` 斜杠命令：`/help` `/provider` `/system` `/user` `/config` `/branch` `/branches` `/tree` `/exit`。

## 提示词预设

- `prompts/system/<name>.md`
- `prompts/user/<name>.md`
- `prompts/judge/<name>.md`（`compare score --judge` 的 rubric）

user 预设可用 `{{input}}`。没有占位符时：`run` / `compare` 把预设当作完整 user 消息；`chat` 会把预设和当前输入拼在一起。

## 文件记录

```text
providers/<name>.json
configs/<name>.json
suites/<name>.json
data/sessions/<session-id>/nodes/<node-id>.json          # 节点：配置快照、消息、usage、cost、requestId
data/sessions/<session-id>/nodes/<node-id>.raw.json      # 原始请求体（无密钥）+ 原始响应 / 错误序列化 + 响应头里的 id
data/sessions/<session-id>/turns/<node-id>.md            # 人读的 turn
data/comparisons/<cmp-id>/report.md                    # 汇总表 + 输入 + 各路成稿
data/comparisons/<cmp-id>/variants/<配置>/output.md     # 该路成稿
data/comparisons/<cmp-id>/variants/<配置>/reasoning.md  # 该路思维链（没有就不生成）
data/tmp/                  # 一次性输入草稿，不进 git
```

每个会话是一棵树。发请求时用当前 system + 祖先链上的 user/assistant。请求失败也会落盘。

查网关怪癖（`reasoning_content` 形态、effort 是否生效、上游到底路由到谁）看 `nodes/<id>.raw.json`：非流式存完整响应对象，流式存拼接后的最终对象和 `chunkCount`，失败存 `error`（name / message / status / body / requestId）。`requestId` 取响应头 `x-request-id`，没有就依次试 `x-oneapi-request-id`（llmcore 用这个）、`x-keybalancer-request-id`、`request-id`、`cf-ray`，都没有就是 `null`；所有像 id 的响应头都在 `headers` 字段里。写盘前会把当前 apiKey 字符串整体打码成 `***`，raw 文件不进 `report.md` / turn md。

`report.md` 开头是一张汇总表（配置 | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 成本 | 错误），`compare` 结束时终端也打这张表。

`compare` 各路并行发请求，缺省并发 3，`--concurrency <n>` 可调；结果始终按输入顺序写入，与完成顺序无关。终端每路开始、结束各打一行，结束行带耗时与是否出错。

`--repeat <n>` 让每路采样 n 次（总任务数 = 路数 × n，与 `--concurrency` 叠加）。每次都以同一个父节点发起，互不串联。汇总表每路仍是一行，耗时 / token / 成本列变成 `均值 (最小–最大)`，只按成功的次数算，失败次数在错误列里显示 `k/n 失败`。`output.md` 与报表正文是第 1 次，每次成稿在 `variants/<配置>/run-<k>.md`。`compare score` 会对每次成稿分别算相似度 / 改动率再取均值（`scores.json` 的 `runs` 里有逐次值），裁判只评第 1 次。`--repeat 1` 与不带参数完全一样。

`compare score <c_id> [--reference <file>] [--baseline <file>]` 对已有对比离线打分，不重跑网关：

- `similarity`：候选与参考答案的字符级 LCS 相似度（0–1）；不给 `--reference` 则为 `null`
- `changeRatio`：候选相对基线（缺省对比输入）的改动比例（0–1）；`barelyChanged` = 改动率 < 5%
- 写 `data/comparisons/<c_id>/scores.json`，并在 `report.md` 汇总表追加「相似度 | 改动率」两列

加 `--judge <config> [--rubric <name>] [--concurrency <n>]` 让一路配置当 LLM 裁判（会发请求）：

- rubric 是 `prompts/judge/<name>.md`，缺省 `default`；模板变量 `{{input}}`、`{{reference}}`、`{{candidate}}`
- 裁判需只输出 `{"score": 0-10, "reason": "..."}`；解析失败只记到该路的 `judge.error`，不影响其他路
- 结果进 `scores.json` 每路的 `judge` 字段，汇总表多一列「裁判」，报表末尾附「裁判理由」
- 每次裁判调用都落到一个新会话（标题 `judge: <c_id>`，每路一个分支），思维链可回看
- 裁判分数有波动：同一配置判同一批候选，两次可差 1–2 分。要下结论就多判几次或换裁判交叉

## 开发

```bash
npm test
npm run typecheck
```

改动走 issue → 分支 → PR → CI，流程与验收要求见 `AGENTS.md` 的「工程流程」；变更记录在 `CHANGELOG.md`。
