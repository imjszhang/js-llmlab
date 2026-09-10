# js-llmlab

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
js-llmlab compare --suite deepseek --message text
js-llmlab compare --provider llmcore --models deepseek-chat,deepseek-v4-flash,deepseek-v4-pro --message text
js-llmlab session ls
js-llmlab session show <id>
js-llmlab branch create --session id --name alt [--from node]
```

`chat` 斜杠命令：`/help` `/provider` `/system` `/user` `/config` `/branch` `/branches` `/tree` `/exit`。

## 提示词预设

- `prompts/system/<name>.md`
- `prompts/user/<name>.md`

user 预设可用 `{{input}}`。没有占位符时：`run` / `compare` 把预设当作完整 user 消息；`chat` 会把预设和当前输入拼在一起。

## 文件记录

```text
providers/<name>.json
configs/<name>.json
suites/<name>.json
data/sessions/<session-id>/...
data/comparisons/<cmp-id>/report.md
```

每个会话是一棵树。发请求时用当前 system + 祖先链上的 user/assistant。请求失败也会落盘。

## 开发

```bash
npm test
npm run typecheck
```
