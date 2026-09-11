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
2. `configs/<name>.json`：引用 `provider`，再覆盖 `model` / `temperature` / `maxTokens`
3. 没有配置文件时，名称当作模型 id，走当前或 `--provider` 指定的网关
4. CLI：`--provider`、`--temperature`、`--max-tokens`（`compare` 不会用 `--model` 冲掉每一路）

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
js-llmlab compare --suite deepseek --message text
js-llmlab compare --suite deepseek-v4-pro-effort --input data/tmp/foo.txt --concurrency 8   # 各路并行，缺省并发 3
js-llmlab compare score <c_id> --reference data/tmp/gold.txt   # 对已有对比算相似度 / 改动率，不发请求
js-llmlab compare score <c_id> --reference data/tmp/gold.txt --judge ds-v4-pro-reason   # 再让 LLM 裁判逐路打 0–10 分
js-llmlab compare --provider llmcore --models deepseek-chat,deepseek-v4-flash,deepseek-v4-pro --message text
js-llmlab session ls
js-llmlab session show <id>
js-llmlab branch create --session id --name alt [--from node]
```

`run` / `compare` 加 `--dry-run` 时输出一段 JSON：解析后的配置快照、密钥变量名与是否已设置、messages、将发送的请求体。不需要 key，不建会话，不写 `data/`。

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
data/sessions/<session-id>/...
data/comparisons/<cmp-id>/report.md                    # 汇总表 + 输入 + 各路成稿
data/comparisons/<cmp-id>/variants/<配置>/output.md     # 该路成稿
data/comparisons/<cmp-id>/variants/<配置>/reasoning.md  # 该路思维链（没有就不生成）
data/tmp/                  # 一次性输入草稿，不进 git
```

每个会话是一棵树。发请求时用当前 system + 祖先链上的 user/assistant。请求失败也会落盘。

`report.md` 开头是一张汇总表（配置 | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 错误），`compare` 结束时终端也打这张表。

`compare` 各路并行发请求，缺省并发 3，`--concurrency <n>` 可调；结果始终按输入顺序写入，与完成顺序无关。终端每路开始、结束各打一行，结束行带耗时与是否出错。

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
