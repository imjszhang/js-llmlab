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
npx tsx src/cli.ts run --config ds-v4-flash --message '...'
npx tsx src/cli.ts run --config ds-v4-pro-reason --input data/tmp/foo.txt
npx tsx src/cli.ts compare --suite deepseek-v4-flash-effort --input data/tmp/foo.txt
npx tsx src/cli.ts compare --configs ds-v4-flash,ds-v4-pro --message '...'
npx tsx src/cli.ts session ls
npx tsx src/cli.ts session show <id>
```

改代码后：

```bash
npm test
npm run typecheck
```

单测用 `node:test` + 临时目录（`tests/helpers.ts` 的 `makeLabRoot` / `makeCommandLab`）。测 `run` / `compare` 编排时，用 `tests/fake-completer.ts` 的 `createFakeCompleter` 通过第二个参数 `deps` 注入，不要碰 `runCompletion`。**禁止**在单测里打真实网关 / llmcore。

## 配置怎么叠

后者覆盖前者：

1. `providers/<name>.json`：`baseURL`、`apiKeyEnv`、默认模型
2. `configs/<name>.json`：引用 `provider`，再写 `model` / `temperature` / `maxTokens` / `thinking` / `reasoningEffort`
3. 没有对应配置文件时，名称当 **模型 id**，走当前或 `--provider`
4. CLI 覆盖：`--provider`、`--temperature`、`--max-tokens`、`--thinking`、`--reasoning-effort`

`thinking` 只有 `enabled` | `disabled`。`reasoningEffort` 只有 `low` | `high` | `max`。V4 开推理 **不是** 新的 model id。

`compare` 注意：

- `--model` **不会**冲掉每一路的模型
- `--thinking` / `--reasoning-effort` **会**作用到所有路
- suite / `--configs` / `--models` 可并用，去重后至少两路
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

- 可复用的才进 `prompts/system/<name>.md`、`prompts/user/<name>.md`
- user 预设可用 `{{input}}`。没有占位符时：`run` / `compare` 把预设当完整 user 消息
- **一次性草稿**放 `data/tmp/`，例如 `--input data/tmp/polish-post.txt`
- 不要把一次性帖子/提示词收进 `prompts/`，除非用户明确要求

## 落盘与 git

```text
data/sessions/<s_id>/          会话树、节点 JSON、turn md
data/comparisons/<c_id>/       report.md + 各路 output.md
data/tmp/                      一次性输入
```

节点里：`messages.assistant` 是成稿，`messages.reasoning` 是思维链，`usage.reasoningTokens` 是推理 token。`run` 终端只打 assistant；推理看 turn md 或 compare 的 report。

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

## 常见坑

- 关 thinking 的 flash 可能几乎不改稿；要比文风先开 reasoning
- llmcore 不保证 `low < high < max` 的推理长度
- `compare --suite x --model y` 不会把各路都换成 y
- 缺密钥时先 `status` / `config show`，不要把 `.env` 内容贴出来
- 测网关用 CLI；回归用 `npm test`，两套不要混
