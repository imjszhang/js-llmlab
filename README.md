# js-llmlab

[![ci](https://github.com/imjszhang/js-llmlab/actions/workflows/ci.yml/badge.svg)](https://github.com/imjszhang/js-llmlab/actions/workflows/ci.yml)

本地 CLI 实验室：测试直接 LLM 调用与 Claude Code / Codex / DeepSeek Harness / OpenCode / Cursor Agent 的任务执行。`.env` 放需要的 API 密钥；`providers/` 描述 LLM 接口；`configs/` 描述模型参数；`targets/` 组合实验对象；`tasks/` 定义输入与验收。用文件保存预设、会话树、分支和实验结果。

创建日期：2026-09-11。文档更新：2026-10-17。

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
# ANTHROPIC_API_KEY=
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

当前主力是 **llmcore**（`https://proxy.llm-core.cn/v1`）。另外预置了 `openai`、`deepseek` 官方入口（`https://api.deepseek.com`，默认模型 `deepseek-flash`），填对应密钥即可用。

还预置 `anthropic` 官方入口（`https://api.anthropic.com/v1`），使用 `ANTHROPIC_API_KEY`；现在共有四个 provider。默认 provider 仍为 llmcore。

主测几套：llmcore 上四套 Chat / 推理，外加官方 Flash 一路。

- `ds-chat` → llmcore / `deepseek-chat`
- `ds-v4-flash` → llmcore / `deepseek-v4-flash`（thinking 关闭）
- `ds-official-flash` → 官方 DeepSeek / `deepseek-flash`（thinking 关闭；表里 provider 列是 `deepseek`，和 llmcore 的 `ds-v4-*` 分开）
- `ds-official-flash-reason` / `-low` / `-max` → 同一官方模型换推理强度
- `ds-official-pro` / `ds-official-pro-reason` / `-low` / `-max` → 官方 `deepseek-v4-pro` 的非思考与三档推理
- `ds-v4-pro` → llmcore / `deepseek-v4-pro`（thinking 关闭）
- `ds-v4-flash-reason` / `ds-v4-pro-reason` → thinking 开启，`reasoningEffort=high`
- `ds-v4-flash-reason-low` / `-max`、`ds-v4-pro-reason-low` / `-max` → 同一模型换推理强度
- `ds-reasoner` → llmcore / `deepseek-reasoner`

推理强度可写在配置文件的 `reasoningEffort`（`low` / `high` / `max`），或命令行 `--reasoning-effort`。

预定义对比组：`suites/deepseek.json`，`suites/deepseek-v4-reason.json`，以及 `deepseek-v4-flash-effort` / `deepseek-v4-pro-effort` / `deepseek-official-flash-effort` / `deepseek-official-pro-effort`。`deepseek-official` 用于官方 Flash / Pro 的非思考与 high 四路对比。

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

`pricing.cachedInputPerMillion` 可选，用于缓存命中的输入 token；`inputPerMillion` 对应未命中输入。响应带命中数量且配置了命中价才分开计算；缺任一项时按统一输入价估算。`usage.promptCacheHitTokens` / `promptCacheMissTokens` 保留服务端计数。

官方已采用峰谷两档价格，涉及中国法定节假日；本工具不自动猜测时段或价格。需要精确估算时，自己维护并选择峰/谷配置。同一实验跨时段时，固定 pricing 仅作估算；Search/Fetch 按次费用也不计入 token 成本。

## Codex 当前订阅与模型选择

Codex target 可以复用当前 ChatGPT 订阅登录，或继续使用显式 API provider。已预置 `codex-chatgpt`（`gpt-6.1-sol`、`low`），可直接用于现有任务和套件。先查看登录与模型目录，再为要比较的模型分别创建 target：

```bash
npm start -- harness codex status
npm start -- harness codex models
npm start -- targets init codex-my-model --auth chatgpt --model <目录中的模型ID> --reasoning-effort medium
npm start -- bench run --task fix-add --targets codex-my-model --dry-run
npm start -- bench run --task fix-add --targets codex-my-model --repeat 3
```

`targets init` 默认使用 `codex-write`，拒绝覆盖已有文件；只读任务可传 `--harness codex`。多模型比较可创建多个 targets 后放入 `--targets` 或 `bench-suites`。推理强度以模型目录为准；目录可能来自原生缓存，账号访问权限以实际执行结果为准。

订阅模式不要求 `OPENAI_API_KEY`，使用当前 `CODEX_HOME`（缺省 `~/.codex`）和原生凭据存储；可用 `--codex-home`、`--credentials-store auto|file|keyring` 显式选择。未登录或当前为 API key 登录时先停止，由用户在该目录下运行 `codex login`。实验不复制登录文件；模型、推理强度和认证来源进入快照，费用标记为订阅、保持未知，仍统计 tokens/耗时。详细隔离边界见 [任务实验说明](docs/harness-bench.md#codex-订阅认证)。

## Claude Code 当前订阅

Claude Code target 支持复用原生 Claude 订阅登录，预置 `cc-claude-sonnet` 和 `cc-claude-opus`。两者使用 `sonnet` / `opus` 别名，由原生 CLI 解析，不代表固定模型版本；也可明确指定完整模型 ID：

```bash
npm start -- harness claude-code status
npm start -- harness claude-code status --json
npm start -- targets init cc-my-opus --harness claude-code-write --auth claude-subscription --model opus
```

任务执行需要 Claude Code 2.1.296 或更新版本，独立状态查询最低要求 2.1.268。订阅 target 不需要 Anthropic API key，也不引用 API provider；认证不符合时停止，不回退到 API 计费。可用 `--claude-config-dir` 指定已登录的原生配置目录，否则沿用当前 `CLAUDE_CONFIG_DIR` 或默认目录。环境中的 `CLAUDE_CONFIG_DIR` 必须是绝对路径，原样保留以匹配认证命名空间。默认目录模式保留原 HOME，显式目录模式使用隔离 HOME；两者都禁用个人定制，但原生凭据刷新可能写入原配置目录。实验室不读取、复制或导出凭据。订阅 `cost` / `costSource` 保持 `null`，仍统计用量与耗时。详细边界见 [任务实验说明](docs/harness-bench.md#claude-code-订阅认证)。

默认目录执行模式目前要求 macOS，以 `sandbox-exec` 包装器阻止读取原 HOME 的 shell 启动文件。其他平台需先在独立的显式 `CLAUDE_CONFIG_DIR` 中完成原生登录，再配置 target。本次接入按要求未运行测试、登录查询或任务实验；这些命令是使用示例，不代表已验证当前账号登录、模型权限或运行时隔离效果。

## Cursor Agent 原生登录与模型选择

Cursor Agent 已接入统一任务执行层，提供 `cursor-agent` / `cursor-agent-write` 两套 profile。预置 `cursor-auto` 复用当前 Cursor 原生登录，`cursor-api-auto` 使用 `CURSOR_API_KEY`；两者都是可写 target，`auto` 由 Cursor 选择实际模型，不代表固定版本。

```bash
npm start -- harness cursor-agent status
npm start -- harness cursor-agent models --json
npm start -- targets init cursor-my-model --harness cursor-agent-write --auth cursor-login --model <目录中的模型ID>
# 使用 Cursor 原生 API key：
npm start -- harness cursor-agent models --auth cursor-api-key
npm start -- targets init cursor-my-api --harness cursor-agent-write --auth cursor-api-key --model <目录中的模型ID>
```

`harness cursor` 是同一查询命令的别名。状态查询区分凭据是否存在与原生验证结果，不判断订阅权益；模型目录可能随服务和账号变化，不保证实际模型权益。显式模型 ID 原样传递，不自动替换。Cursor 连接自己的服务，不接受现有 DeepSeek 等 LLM provider；provider 总数仍为四个。API key 可通过 `--api-key-env` 指定环境变量名，查询时须已在环境中设置；不要把密钥写进 target。

当前适配锁定已核对源码的 Cursor CLI `2026.07.23-e383d2b`，由用户独立安装。原生登录模式目前仅支持 macOS：预置 profile 显式保留本机 HOME 供 Cursor 自己使用认证，配置、数据与工具 shell HOME 按运行隔离，实验室不解析或复制凭据。Linux 可使用 `cursor-api-key`；该模式仍隔离原生 HOME，凭据仅交给原生内存存储，不写入配置。任务执行的 shell 包装器要求 POSIX 平台。

执行启用原生沙箱与显式工具权限。原生登录保留的本机 HOME，以及远端账号/团队插件、hooks 或托管 skills，都可能影响上下文，不能据此认为不同 harness 的条件完全相同。当前没有完整重试/推理用量保证，统一 `usage` / `cost` 保持未知，原始事件保留供审计；不套用 LLM API 价格。2026-10-18 已完成离线回归、当前设备登录/模型查询及真实图片连接诊断；本地兼容修复与边界详见 [Cursor Agent 说明](docs/harness-bench.md#cursor-agent-原生服务)。

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
js-llmlab targets ls
js-llmlab targets show cc-ds-pro
js-llmlab tasks ls
js-llmlab tasks show fix-add
js-llmlab tasks init csv-merge --template data
js-llmlab tasks validate csv-merge
js-llmlab tasks validate --all
js-llmlab harness ls
js-llmlab harness show codex-write
js-llmlab harness codex status                    # 当前订阅登录状态，无凭据输出
js-llmlab harness codex models                    # 模型目录与支持的推理强度
js-llmlab targets init codex-my-model --auth chatgpt --model <模型ID> --reasoning-effort medium
js-llmlab harness claude-code status [--json] [--claude-config-dir <路径>]
js-llmlab targets init cc-my-opus --harness claude-code-write --auth claude-subscription --model opus
js-llmlab harness cursor-agent status [--auth cursor-login|cursor-api-key] [--api-key-env <变量名>] [--json]
js-llmlab harness cursor-agent models [--auth cursor-login|cursor-api-key] [--api-key-env <变量名>] [--json]
js-llmlab targets init cursor-my-model --harness cursor-agent-write --auth cursor-login --model <模型ID>
js-llmlab bench run --task hello --targets llm-ds-pro,cc-ds-pro,codex-ds-pro --dry-run
js-llmlab bench run --task fix-add --targets cc-ds-pro,codex-ds-pro --repeat 3 --concurrency 2
js-llmlab bench run --task hello --targets dsh-ds-pro,opencode-ds-pro --dry-run
js-llmlab bench run --task fix-add --targets dsh-ds-flash,opencode-ds-flash --repeat 3 --concurrency 2
js-llmlab bench ls
js-llmlab bench show <b_id>
js-llmlab bench suites ls
js-llmlab bench run --suite harness-regression --dry-run
js-llmlab bench run --suite harness-regression
js-llmlab bench report <e_id或b_id> [更多b_id] --format markdown
```

`run` / `compare` 加 `--dry-run` 时输出一段 JSON：解析后的配置快照、密钥变量名与是否已设置、messages、将发送的请求体。不需要 key，不建会话，不写 `data/`。

`run` 的 stdout 只有成稿，方便 `> out.md` 或接管道；`新建会话 …`、`session=… node=…`、重试提示、进度都走 stderr。不加 `--stream` 时，如果 stderr 是终端，每 5 秒打一行 `等待 <配置> → <模型>… Ns`，管道里不打。加 `--stream` 时成稿一段段打到 stdout，思维链变暗打到 stderr（`--hide-reasoning` 关掉）；两种方式落盘的节点字段与 usage 口径一样。

`compare` 的各路先按名字去重，再按解析后的快照去重：`--configs ds-v4-flash --models deepseek-v4-flash` 两个名字落到同一个请求，只跑一路，终端会提示被跳过的名字。只差 effort / temperature 等参数的路不会被合并。

`chat` 斜杠命令：`/help` `/provider` `/system` `/user` `/config` `/branch` `/branches` `/tree` `/exit`。

## Harness 与任务实验

`bench` 使用独立的任务执行层。直接 LLM target 复用现有模型配置和请求客户端；harness target 单独选择执行工具、权限及模型后端。现在支持五种 harness，每种提供只读和可写两套 profile，共十套；provider 数量仍是四个。

| 文件 | 定义 |
| --- | --- |
| `providers/<name>.json` | 地址、密钥变量名与显式协议端点 |
| `configs/<name>.json` | 直接 LLM 的模型、thinking、effort 等参数 |
| `harnesses/<name>.json` | Claude Code / Codex / DeepSeek Harness / OpenCode / Cursor Agent、可执行文件与读写权限 |
| `targets/<name>.json` | 一套直接 LLM 配置，或 harness + API / 订阅 backend + model |
| `tasks/<name>.json` | prompt、fixture、执行时限和验收条件 |
| `bench-suites/<name>.json` | 多任务、显式 targets、重复次数、全局并发和本轮预算 |

首次使用先跑 `bench ... --dry-run`，再运行 `hello` 验证连接。实际 harness 运行需要自行安装对应 CLI 并使其在 PATH 中；也可在 harness 配置的 `executable` 填绝对路径。本工具先记录 CLI 版本，再执行任务。CLI 必须支持当前非交互参数；旧版缺参数会记录失败。新增 adapter 按官方 npm `@deepseek-ai/dsh@0.2.0-rc.2`（命令 `dsh`）与 `@opencode/cli@2.0.32`（命令 `opencode`，V2）实现；OpenCode V1 会在启动任务前拒绝。它们是独立工具，不加入本项目的 npm 依赖。

| Harness | 只读 / 可写 profile | 协议 | 预置 targets |
| --- | --- | --- | --- |
| Claude Code | `claude-code` / `claude-code-write` | `anthropic-messages` | `cc-ds-pro` / `cc-ds-flash` |
| Codex | `codex` / `codex-write` | `responses` | `codex-ds-pro` / `codex-ds-flash` |
| DeepSeek Harness | `deepseek-harness` / `deepseek-harness-write` | `anthropic-messages` | `dsh-ds-pro` / `dsh-ds-flash` |
| OpenCode V2 | `opencode` / `opencode-write` | `chat-completions` | `opencode-ds-pro` / `opencode-ds-flash` |
| Cursor Agent | `cursor-agent` / `cursor-agent-write` | Cursor 原生服务 | 不支持套用 DeepSeek provider；原生 targets 为 `cursor-auto` / `cursor-api-auto` |

provider 的 `endpoints` 必须显式声明对应协议；不兼容的组合在启动前拒绝。DeepSeek Harness 使用自身的原生 DeepSeek Messages adapter，会发送 `thinking` / `output_config` 扩展；后端必须接受这些字段，不能仅凭声明 Messages 就认定所有 Claude 型号兼容。表中原有四组 Pro/Flash targets 都使用同一个 `deepseek` provider，Pro 为 `deepseek-v4-pro`，Flash 为 `deepseek-flash`。

LLM provider API targets 使用 provider 的 API key 和独立 HOME/配置；Codex 与 Claude Code 另可显式复用原生订阅登录，认证目录和 HOME 的边界见上文。原有四种 adapter 禁用个人 skills、MCP 和记忆；Cursor 隔离本地配置，但仍可能加载远端账号/团队扩展。DeepSeek Harness 使用无服务的 headless profile，关闭遥测、附加模型调用和委派；OpenCode 使用 V2 的 standalone 运行，其临时 `serve --stdio` 随任务退出，禁用用户/项目配置加载，并通过本项目生成的可信插件清除模型 shell 环境中的凭证。OpenCode 的机器管理策略仍会生效。`read-only` / `workspace-write` 通过各 harness 自身工具权限实施；OpenCode 的工具策略不等于操作系统沙箱，独立目录也不提供容器隔离。

每个 target × repeat 都从同一冻结 fixture 复制到独立工作区，登录认证按各 CLI 的原生存储边界复用。直接 LLM 只接收 system 与 task prompt，不自动读取 fixture、执行工具或修改文件；适合回答类基线。`fix-add` 则用于测试能编辑文件的 harness。跨 harness 比较还应记录各自默认提示与推理行为，单次结果不足以判断优劣。

新增两道可重复的任务：`fix-order-total` 修复金额、折扣、运费与订单汇总等多个模块；`normalize-orders` 从原始 CSV 与客户映射生成规范化订单、拒收清单及地区汇总。两题统一 300 秒执行预算，使用任务定义内嵌的独立验收断言；数据题还会更换输入重跑脚本，检查是否能复用。

`cc-ds-pro` / `codex-ds-pro` 使用官方 `deepseek-v4-pro`，`cc-ds-flash` / `codex-ds-flash` 使用同一 `deepseek` provider 的 `deepseek-flash`。每组只切换 backend.model，保留各自 harness 设置。例如：

```bash
npm start -- bench run --task fix-order-total --targets cc-ds-pro,codex-ds-pro --repeat 3 --concurrency 6
npm start -- bench run --task normalize-orders --targets cc-ds-pro,codex-ds-pro --repeat 3 --concurrency 6
npm start -- bench run --task fix-order-total --targets cc-ds-flash,codex-ds-flash --repeat 3 --concurrency 6
npm start -- bench run --task normalize-orders --targets cc-ds-flash,codex-ds-flash --repeat 3 --concurrency 6
```

以上共 24 次真实执行；同组并发 6，所有采样都使用独立目录。通过率分母包括失败与超时；单次 smoke 及每题三次采样只能反映这些任务上的表现。Claude Code 和 Codex 分别使用 Messages / Responses，各自默认提示和推理参数不同；harness 报价不作为 DeepSeek 账单比较。

执行状态与验收状态分别记录。只有收到 harness 成功终态才算 `completed`；输出截断、CLI 错误或超时都是失败。OpenCode V2 快速响应可能漏发最后的 JSON 步骤事件，因此还会通过官方会话导出核验持久终态、输入与后端；后验不带模型凭据，共享任务预算。任务可检查输出文本、文件存在/内容，或运行无 shell 的命令断言。无检查或执行失败显示 `not-run`。token / 成本缺失保留 `null`；Claude 只报告总费用时，不捏造输入输出拆分。DeepSeek Harness / OpenCode 当前不报告可信的后端费用或实际响应模型，`cost` / `responseModel` 保持 `null`；配置中的模型名只表示请求选择。累计 token 按各 CLI 的缓存及推理语义归一化，细节见任务实验指南。

结果写到 `data/benchmarks/<b_id>/`，含任务/路由快照、fixture 内容与 hash、每次采样的执行记录、原始输出、事件、文件变化、工作区和汇总报告，默认不进 Git。整个 harness 任务不会自动重跑；harness 内部可能自行重试请求。详细配置和结果结构见 [任务实验指南](docs/harness-bench.md)。

执行进程继承设备的 HTTP/HTTPS/ALL/NO_PROXY 代理设置（含小写形式），显式进程配置优先，其他 provider 密钥仍不继承。带认证信息的代理会在记录中脱敏。运行中新建的真实 `.venv` / `venv` 目录不计入作品快照和 manifest 文件验收；原素材中已有的同名目录仍受检查，其他符号链接仍拒绝。

### 神经网络视频单次生成

`neural-network-video` 保存中文“全代码、竖屏、解释神经网络”的原始短提示，
仅将样式路径改为工作区内的独立参考包。样式规范与 4 张参考图已冻结到题目
素材，不再依赖原项目。`neural-network-video-opus` 套件使用 Claude Code +
Anthropic 官方 Opus 5.5，每次一个样本、60 分钟执行预算，不额外指定框架或时长。

当前提示在原短提示后追加：必须实际渲染并输出可播放的 MP4，不能只交 HTML 或源码。原始提示存档保留，已有实验继续使用各自冻结的输入；其他任务和运行设置不变。

后续复测再追加：必须保证中文字体正常、文字清晰可读，交付前检查实际渲染画面并自行修复问题。字体查找、安装和画面检查由 harness 自主完成，不预装字体或改动原验收器。

```bash
npm start -- tasks validate neural-network-video
npm start -- bench run --suite neural-network-video-opus --dry-run
npm start -- bench run --suite neural-network-video-opus
```

默认套件需要 Claude Code 与 `ANTHROPIC_API_KEY`；技术验收需要
`ffprobe`。自动检查源码、视频容器、可读帧、正时长和竖屏，科学准确性、视觉
质量与代码复现另外人工评审。单次指一次人类委托，允许 harness 内自主调用
工具；不代表一次 API 请求。提示词、素材来源与评分表见
[视频测试说明](docs/neural-network-video.md)。

测试自主完成能力时，可明确选择完整工具权限，让 Claude Code 自行安装依赖和渲染。代理、认证来源、实际权限及初始环境须在启动前记录；启动后不修改环境、不追加提示、不停止安装进程。当前设备网关的单次运行按其实际 provider 单独记录，不冒充 Anthropic 官方接口。

### 新增题目、整组运行与统一报告

`tasks init <name> --template repair|data|answer` 生成提示词、fixture、可信 checker 和独立的参考/负例自测素材，拒绝覆盖已有文件。编辑后用 `tasks validate <name>` 离线验证；`--all` 检查整个题库。自检不调用模型或 harness，不需要密钥。旧任务没有声明自测时只检查结构，并明确提示尚未验证参考解。

新任务可以引用 `checks: [{"kind":"script","file":"tasks/checks/<name>.mjs"}]`，源码在加载时展开并固定到实验快照。`manifest` 可声明不可修改和允许编辑的文件，加载时从素材计算约束；参考解和负例保持在 fixture 外。原有内嵌 command 的四个任务继续可用。

实验套件放在 `bench-suites/`，与原先 `compare` 的 `suites/` 分开。套件引用已有 tasks 和 targets，每题默认重复 3 次，整组共享并发上限；运行前冻结全部题目的素材。`--repeat` / `--concurrency` 覆盖套件设置，`--timeout-ms` 只覆盖本轮预算，保留源任务。套件产生 `e_…` 实验组，子任务继续保存为兼容的 `b_…` 实验；`bench ls` 和 `bench show` 都能查看。

```bash
npm start -- bench run --suite harness-regression --dry-run
npm start -- bench run --suite harness-regression --timeout-ms 600000
npm start -- bench report <e_id> --format json --output data/tmp/bench-analysis.json
npm start -- bench report <b_id1> <b_id2> --format csv --output data/tmp/bench-analysis.csv
npm start -- bench report <e_id> --pricing data/tmp/prices.json --scenario offPeak
```

统一报告只读取冻结记录，输出每题通过/超时、完整性、全样本及成功耗时、用量覆盖率，套件再按任务等权汇总。重复 ID 去重，不同实验轮次、预算或配置分别展示；缺失记录不会算作通过。没有价格文件时不把 harness 的原生报价当作后端账单；显式提供价格文件可离线重算，缓存命中/未命中/输出分别计费，缺用量保留未知，峰谷情景由用户选择。`--output` 只创建新报告文件，拒绝覆盖原文件。价格文件格式见任务实验指南。

## DeepSeek 官方能力

截至 2026-10-17，官方 `deepseek-flash` 对应 V4.1-Flash-1017，`deepseek-v4-pro` 对应 V4-Pro-0813。两者 1M 上下文、最大 384K 输出（本地配置仍采用保守输出上限，可用 `--max-tokens` 调整）。Flash 支持图片，Pro 不支持。旧 Flash 别名会转到新模型，不能固定旧版本。`responseModel` 保存响应的 `model` 字段；服务端若只返回别名，这个字段也不能证明实际版本固定。

| 能力 | 入口 |
|---|---|
| 文本、思考、流式、多轮、并行对比 | 原有 `run` / `compare` |
| 图片、Files 图片引用 | `run` / `compare --image <路径或URL...> --file-id <id...>` |
| JSON 输出 | `run` / `compare --json-output` |
| 函数工具声明、完整工具结果续接 | `--tools <数组文件> --messages <完整消息数组文件>` |
| 前缀续写（Beta） | `--prefix <assistant前缀>` |
| top_p、stop、logprobs、tool_choice、user_id 等高级参数 | `--request <附加参数文件>`，或 `api chat --request <完整JSON>` |
| Responses、服务端 web_search、apply_patch 工具协议 | `api responses --request <完整JSON>` |
| Anthropic 兼容格式 | `api messages --request <完整JSON>` |
| FIM 中间补全（Beta） | `api fim --request <完整JSON>` |
| 独立 Search / Fetch | `deepseek search <query>` / `deepseek fetch <url>` |
| Files 上传、分页列表、元数据、删除 | `deepseek files upload/list/get/delete` |
| 官方模型、余额 | `deepseek models` / `deepseek balance` |

```bash
npx tsx src/cli.ts run --config ds-official-flash --message '分析截图' --image data/tmp/screenshot.png
npx tsx src/cli.ts compare --suite deepseek-official-flash-effort --message '分析图表' --image data/tmp/chart.png --repeat 3
npx tsx src/cli.ts run --config ds-official-flash --message '返回含 answer 的 JSON 对象' --json-output
npx tsx src/cli.ts run --config ds-official-flash --message '写一个函数' --prefix 'def add(a, b):'
npx tsx src/cli.ts api responses --request '{"input":"只输出 OK","reasoning":{"effort":"none"}}' --dry-run
npx tsx src/cli.ts deepseek search 'DeepSeek site:api-docs.deepseek.com' --request '{"count":3,"need_content":true}'
npx tsx src/cli.ts deepseek fetch https://api-docs.deepseek.com/zh-cn/guides/vision/
npx tsx src/cli.ts deepseek files upload data/tmp/screenshot.png
```

`run` / `compare` 的 `--request` 是附加参数对象，不能覆盖 model、temperature、max_tokens、thinking、reasoning_effort、stream 或 messages；这些字段分别走配置、CLI 或 `--messages`。`api` 的 `--request` 是完整原始协议对象，可用文件或内联 JSON，保留未知字段；不指定配置时默认使用官方 provider，不影响原有默认 llmcore。各接口支持 `--dry-run`，无 key、不访问网络、不写 data。

高级会话在 `messages.apiMessages` 保存真实消息块、工具调用和 reasoning，后续 `run --session` 继续保留；`--messages` 则显式替换请求消息，工具结果文件可直接包含之前的完整历史。工具由调用方执行，CLI 会保存调用参数，不自动执行模型生成的程序。`compare` 将解析后的请求扩展和内联图片快照写进 `spec.request`，补跑不重新读取原附件。普通纯文本历史格式保持兼容。

官方思考模式默认开启、默认 high；此时 temperature / presence_penalty / frequency_penalty 不生效。携带 tools 时必须完整回传历史 assistant 的 reasoning_content。Responses 无状态，需要自行回传完整 input，previous_response_id 不能代替历史；其内置 web_search 仅支持 Pro。Files 只接受图片，官方未提供文件内容下载接口。完整协议示例、限制与来源见 [官方 API 使用指南](docs/deepseek-api.md)。

`api` / `deepseek` 调用单独记录在 `data/api/<id>/`：请求、完整响应、SSE 事件、状态、request id 与错误。`--json` 输出完整协议结果便于继续拼接工具或 Responses 历史；这些调用不会伪装成纯文本会话节点。它们的配置快照只提供缺省值，完整请求文件可能覆盖模型参数，复现时以 request.json 为准。

## Anthropic / Claude

`anthropic` 在 `run` / `compare` 中使用官方 OpenAI SDK 兼容接口。核对日期 2026-10-17，预置 `claude-sonnet` / `claude-opus` / `claude-haiku`，分别使用 `claude-sonnet-5-5` / `claude-opus-5-5` / `claude-haiku-5-5`；默认模型为 Sonnet，输出上限 4096，temperature 为 1，不预置价格。其他可用模型可用模型 ID 配合 `--provider anthropic`。

```bash
npx tsx src/cli.ts provider show anthropic
npx tsx src/cli.ts config show claude-sonnet
npx tsx src/cli.ts run --config claude-sonnet --message '用一句话介绍自己' --dry-run
npx tsx src/cli.ts run --config claude-sonnet --message '解释注意力机制' --stream
npx tsx src/cli.ts compare --suite claude --message '解释注意力机制'
npx tsx src/cli.ts compare --configs ds-official-flash,claude-sonnet --message '解释注意力机制'
npx tsx src/cli.ts models --provider anthropic
```

兼容入口支持文字、图片、工具声明与结果续接、普通及流式成稿、用量与原始记录；Anthropic 模型列表使用原生鉴权并读取全部分页。兼容层不返回 Claude 思考内容或推理 token 明细，因此 `reasoning` / `reasoningTokens` 保持 null。不能把这理解成模型未思考。

兼容层会把所有 system / developer 消息合并并移到对话开头；需要在历史中途改变 system 指令时，请使用原生 Messages。

兼容层会忽略 `reasoning_effort`、`response_format`、工具 strict、缓存控制等字段，因此本地会拒绝这些请求并提示原生入口。通用 `--thinking` / `--reasoning-effort`、`--json-output`、Files 引用和此前缀续写选项也不用于 Anthropic 兼容层；新 Claude 模型还限制温度与强制工具调用。`--image` 的本地图片及 URL 可用，工具定义不要设置 `strict: true`。

需要原生 thinking、effort、严格结构化输出或缓存时，使用原始 Messages（地址为 `/v1/messages`，自动带 x-api-key 和 anthropic-version）：

```bash
npx tsx src/cli.ts api messages --provider anthropic --request '{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"解释注意力机制"}],"thinking":{"type":"adaptive"},"output_config":{"effort":"high"},"max_tokens":4096}' --stream
```

原始请求中的协议字段保持原样，不按 DeepSeek 的 thinking 规则改写；各模型支持的思考模式以官方文档为准。原生调用独立记录在 `data/api/`，不计入会话树或 compare 评分；计价要自行填写对应 USD 价格，多 workspace 凭证所需头可通过 `--headers` 传入。来源：[模型表](https://platform.claude.com/docs/en/models/overview)、[兼容接口及限制](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)、[模型列表](https://platform.claude.com/docs/en/api/models/list)。

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

`report.md` 开头是一张汇总表（配置 | provider | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 成本 | 错误），`compare` 结束时终端也打这张表。官方 DeepSeek 与 llmcore 同场时靠 `provider` 列区分（`deepseek` vs `llmcore`）。

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

Cursor 代理网络：预置 profile 使用 HTTP/1.1 SSE（`useHttp1ForAgent: true`），并让原生请求及 shell 继承标准代理变量；不会关闭 TLS 校验。另设置 `nativeStallTimeoutMs: 300000`，通过版本及原始文件 SHA-256 校验后的本地内存补丁，放宽原生 30 秒无完整消息的等待时间，防止大图片仍在传输时被反复重连；总任务时限不变，安装文件不改动。配置与兼容补丁进入运行快照，旧 profile 缺省此字段不启用补丁。预置 profile 还显式保留原生登录所需的本机 HOME，配置/数据及工具 shell 继续隔离；原生可能加载本机上下文。边界与自主视频实验的单次运行配置见 [harness 说明](docs/harness-bench.md)。

### 视频实验正式配置与评审

使用 `neural-network-video-flash-full` / `neural-network-video-opus-full` / `neural-network-video-cursor-full` 套件：完整权限、60 分钟、128 MiB 日志上限、显式代理策略，每次只跑一个样本。先 `bench run --suite <name> --dry-run` 检查配置；普通 profile 和旧套件不变。

`bench review-template <b_id> --output <新JSON>` 生成绑定历史记录指纹的评审模板；填写后通过 `bench report <b_id...> --review <JSON> [--pricing <JSON> --scenario <name>]` 同时展示人工评审和成本核对。自动验收、原始用量/费用与核对口径保持分开，旧记录无需迁移。完整权限范围、附件格式和命令见 [视频实验说明](docs/video-experiments.md)。
