# js-llmlab

本地 CLI 实验室：对接 OpenAI 兼容接口，用环境变量和命名配置切换 provider / 模型，用文件保存 system/user 预设、会话树、分支和对比实验结果。

创建日期：2026-09-11。

## 要求

- Node.js >= 20
- npm

## 安装

```bash
cd /Users/jszhang/github/my/js-llmlab
npm install
cp .env.example .env
```

编辑 `.env`，填入密钥和默认入口。DeepSeek 示例：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
```

本地运行：

```bash
npx tsx src/cli.ts status
# 或
npm start -- status
# 或
npx js-llmlab status
```

## 配置分层

后者覆盖前者：

1. 环境变量：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`，以及可选的 `OPENAI_TEMPERATURE`、`OPENAI_MAX_TOKENS`、`JS_LLMLAB_DATA_DIR`
2. `configs/<name>.json` 命名配置（密钥不进文件，只用 `apiKeyEnv` 指向环境变量名）
3. CLI：`--model`、`--temperature`、`--max-tokens`

落盘快照只保留 `name` / `baseURL` / `model` / `temperature` / `maxTokens`，不会写出 API Key。

## 提示词预设

- `prompts/system/<name>.md`
- `prompts/user/<name>.md`

user 预设可用 `{{input}}`。没有占位符时：`run` / `compare` 把预设当作完整 user 消息；`chat` 会把预设和当前输入拼在一起。

## 命令

```bash
js-llmlab status
js-llmlab chat [--session id] [--branch name] [--config name] [--system name] [--user name]
js-llmlab run --message text|--input file [--session] [--branch] [--config] [--system] [--user]
js-llmlab session ls
js-llmlab session show <id>
js-llmlab branch create --session id --name alt [--from node]
js-llmlab branch ls --session id
js-llmlab compare --configs a,b --message text|--input file [--system] [--user] [--session] [--from node]
```

`chat` 斜杠命令：`/help` `/system` `/user` `/config` `/branch` `/branches` `/tree` `/exit`。`/branch <name>` 已存在则切换，不存在则从当前 head fork。

## 文件记录

项目根从当前目录向上查找 `package.json` 且 `name === "js-llmlab"`。数据默认写在 `data/`（可用 `JS_LLMLAB_DATA_DIR` 覆盖）。

```text
data/sessions/<session-id>/
  meta.json
  nodes/<node-id>.json
  turns/<node-id>.md
  branches/main.json
  branches/<name>.json

data/comparisons/<cmp-id>/
  spec.json
  variants/<config-name>/output.md
  variants/<config-name>/meta.json
  report.md
```

每个会话是一棵树。发请求时用**当前** system + 祖先链上的 user/assistant。中途 `/system` 只影响之后的轮次。请求失败也会落盘，节点带 `error`。

## 开发

```bash
npm test
npm run typecheck
```
