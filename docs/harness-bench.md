# Harness 任务实验

更新：2026-10-18。

`run` / `compare` 保留原有会话与文本对比行为。`bench` 面向任务：统一执行直接 LLM 与 harness，并检查输出或工作目录中的结果。

## 快速开始

```bash
npx tsx src/cli.ts targets ls
npx tsx src/cli.ts tasks show hello
npx tsx src/cli.ts bench run --task hello --targets llm-ds-pro,cc-ds-pro,codex-ds-pro --dry-run
# 安装 CLI、配置 DEEPSEEK_API_KEY 后：
npx tsx src/cli.ts bench run --task hello --targets llm-ds-pro,cc-ds-pro,codex-ds-pro
npx tsx src/cli.ts bench run --task fix-add --targets cc-ds-pro,codex-ds-pro --repeat 3 --concurrency 2
npx tsx src/cli.ts bench run --task hello --targets dsh-ds-pro,opencode-ds-pro --dry-run
npx tsx src/cli.ts bench run --task hello --targets dsh-ds-pro,opencode-ds-pro
npx tsx src/cli.ts bench run --task fix-add --targets dsh-ds-pro,opencode-ds-pro --repeat 3 --concurrency 2
npx tsx src/cli.ts bench run --task fix-add --targets dsh-ds-flash,opencode-ds-flash --repeat 3 --concurrency 2
npx tsx src/cli.ts bench ls
npx tsx src/cli.ts bench show b_0123456789
```

`--targets` 至少一路，按名称去重；`--repeat` 缺省 1，`--concurrency` 缺省 3。报告按 target 输入顺序和采样编号排列。不同 target 即使配置相同也保留，方便有意做重复实验。实际运行的执行失败、验收失败或验收基础设施错误使 CLI 退出码为 1；没有验收条件的成功执行退出码为 0，验收显示 `not-run`。

## 定义实验对象

直接模型 target 放在 `targets/<name>.json`，引用现有 `configs/`；`system` 缺省 `default`，空字符串关闭：

```json
{ "name": "llm-ds-pro", "kind": "llm", "config": "ds-official-pro-reason" }
```

Harness profile 放在 `harnesses/<name>.json`，只描述执行工具：

```json
{
  "name": "claude-code-write",
  "adapter": "claude-code",
  "executable": "claude",
  "permission": "workspace-write"
}
```

支持五种 adapter，共十套 profile，LLM provider 仍为四个：

| Adapter | 只读 profile | 可写 profile | CLI / 实现核对版本 | 后端协议 |
| --- | --- | --- | --- | --- |
| `claude-code` | `claude-code` | `claude-code-write` | `claude` 2.1.296 | `anthropic-messages` |
| `codex` | `codex` | `codex-write` | `codex` 0.163.0-alpha.10.2 | `responses` |
| `deepseek-harness` | `deepseek-harness` | `deepseek-harness-write` | `dsh`，官方 npm `@deepseek-ai/dsh@0.2.0-rc.2` | `anthropic-messages` |
| `opencode` | `opencode` | `opencode-write` | `opencode`，官方 npm `@opencode/cli@2.0.32`（V2） | `chat-completions` |
| `cursor-agent` | `cursor-agent` | `cursor-agent-write` | `cursor-agent`，锁定 `2026.07.23-e383d2b` | Cursor 原生服务，不引用 LLM provider |

CLI 由用户独立安装，不加入本项目的 package.json；`executable` 可为 PATH 中的名称或本地绝对路径。权限只有 `read-only` / `workspace-write`，没有使用绕过权限的启动参数；不支持的参数应使任务失败。OpenCode V1 与 V2 的命令和配置不同，版本探测发现 V1 会在真正执行任务前拒绝。表中的版本表示实现对照的 CLI/发行包，不能替代本地连通和验收检查。

新增两套 CLI 可分别用 `npm install --global @deepseek-ai/dsh@0.2.0-rc.2` 和 `npm install --global @opencode/cli@2.0.32` 安装，再用 `dsh --version` / `opencode --version` 检查 PATH。也可以安装到独立目录并在本次命令的 PATH 中加入对应 `node_modules/.bin`；本次开发验证使用后一种方式，位置为 `data/tmp/harness-tools/dsh` 与 `data/tmp/harness-tools/opencode-v2`。各 CLI 的系统与 Node 要求按其官方版本执行。

复用本机本次隔离安装，在项目根目录执行：

```bash
export PATH="$PWD/data/tmp/harness-tools/dsh/node_modules/.bin:$PWD/data/tmp/harness-tools/opencode-v2/node_modules/.bin:$PATH"
npx tsx src/cli.ts bench run --task fix-add --targets dsh-ds-flash,opencode-ds-flash
```

Harness target 显式选择 profile 与 backend：

```json
{
  "name": "cc-ds-pro",
  "kind": "harness",
  "harness": "claude-code-write",
  "backend": {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "protocol": "anthropic-messages"
  }
}
```

`model` 使用后端原始模型名。此 target 不继承 `configs/` 的 temperature/thinking/effort，也不继承默认 `JS_LLMLAB_PROVIDER`；harness 有自己的系统提示与请求参数。LLM provider backend 的 key 来自 provider 的 `apiKeyEnv`。Codex 另支持 `auth: "chatgpt"`，Claude Code 另支持 `auth: "claude-subscription"`，显式复用各自的原生订阅登录。Cursor 使用 `cursor-login` / `cursor-api-key`，连接自己的原生服务。Codex backend 可选 `reasoningEffort`，按原值传给原生 CLI；其他 harness 不接受该 Codex 参数。

Provider 的协议能力单独声明：

```json
{
  "name": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "endpoints": {
    "chat-completions": "https://api.deepseek.com",
    "anthropic-messages": "https://api.deepseek.com/anthropic",
    "responses": "https://api.deepseek.com/v1"
  }
}
```

`baseURL` 继续服务原有直接调用；`endpoints` 用于显式协议匹配。Claude Code / DeepSeek Harness 只接 `anthropic-messages`，地址是原生根，由 CLI 添加 `/v1/messages`；Codex 只接 `responses`，地址是 API 前缀，由 CLI 添加 `/responses`；OpenCode 只接 `chat-completions`，地址是 API 前缀，由 CLI 添加 `/chat/completions`。Anthropic 官方声明 Messages，OpenAI 官方声明 Responses，llmcore 只声明已确认的 Chat Completions。缺声明或协议不匹配会在建实验目录前拒绝，不会隐式转换或启动协议桥接服务。

DeepSeek Harness 使用它自身的原生 DeepSeek Messages adapter。该 adapter 的内部注册名是 `deepseek-official`，实验室的 provider 名称仍由 target 独立指定，endpoint、model 和 API key 都由 target/provider 显式传入。它默认发送 `thinking: { type: "enabled" }` 和 `output_config: { effort: "high" }` 等 DeepSeek Messages 扩展；声明相同协议并不保证所有 Anthropic 模型都兼容这些字段。预置 targets 使用官方 DeepSeek 接口，不进行协议转换。

新增四个 target：`dsh-ds-pro` / `dsh-ds-flash` 与 `opencode-ds-pro` / `opencode-ds-flash`，均使用同一个 `deepseek` provider，模型分别为 `deepseek-v4-pro` / `deepseek-flash`，选择各自可写 profile。原有 Claude Code / Codex targets 保留，provider 数量仍为四个。

## Codex 订阅认证

订阅 backend 独立于 `providers/`，必须显式给出模型，不借用 OpenAI API provider 或默认模型：

```json
{
  "name": "codex-my-model",
  "kind": "harness",
  "harness": "codex-write",
  "backend": {
    "auth": "chatgpt",
    "model": "gpt-6.1-sol",
    "reasoningEffort": "medium"
  }
}
```

已预置 `codex-chatgpt` target，使用 `gpt-6.1-sol` / `low`（本机目录默认值）。上面展示独立模型 target 的配置方式。用 `harness codex models` 查询本机 Codex 目录与支持的推理强度；目录可能来自原生缓存，不保证账号对每个模型都有权限。执行只使用所选 ID，不自动换模型。推理强度支持 `none/minimal/low/medium/high/xhigh/max/ultra` 的配置值，实际可接受值由模型决定；省略时保留原生默认值，快照不伪造有效强度。直接 LLM 的 `thinking/reasoningEffort` 规则保持原样。

```bash
npm start -- harness codex status
npm start -- harness codex models --json
npm start -- targets init codex-my-model --auth chatgpt --model gpt-6.1-sol --reasoning-effort medium
npm start -- bench run --task fix-add --targets codex-my-model --dry-run
# 也可创建显式 API target：
npm start -- targets init codex-my-api --auth api-key --provider deepseek --model deepseek-v4-pro
```

`targets init` 默认 `--harness codex-write --auth chatgpt`，只写新文件。订阅 backend 不允许混入 provider/protocol/baseURL/apiKeyEnv/pricing；API backend 不允许订阅字段。`chatgpt` 仅限 Codex adapter，Claude Code 使用下节的独立认证模式。旧 target 缺少 auth 时继续走 API key，旧记录无需迁移。

`backend.codexHome` 可选，缺省解析当前 `CODEX_HOME` 或 `~/.codex`，相对路径以项目根为准；解析后的绝对路径进入本轮快照。`backend.credentialsStore` 缺省 `auto`，也可明确 `file` 或 `keyring`。CLI 查询对应参数为 `--codex-home`、`--credentials-store`。实验室通过原生 Codex 读取登录状态，不读取/解析/复制 `auth.json` 或导出 keyring。版本探测使用隔离认证目录；实际执行前检查当前认证是 ChatGPT，API key/未登录/未知认证均拒绝，不自动调用 login/logout，也不使用可能在认证不匹配时登出的 `forced_login_method`。同一原生认证目录在实际使用中可由 Codex 自动刷新凭据。

执行使用独立 HOME/workspace 和原生 `--no-daemon exec --ephemeral --ignore-user-config --ignore-rules`，保留只读/可写权限，关闭个人指令、host skills、插件、hooks、apps、MCP、子 agent 和 web search，日志与 SQLite 状态重定向到本轮目录。订阅执行使用原生命名权限 profile，继承对应的 `:workspace` / `:read-only` 并显式禁止工具读取认证目录；不同时传会覆盖该 profile 的 `--sandbox`。共享 CODEX_HOME 是认证复用边界，不能宣称完全隔离所有原生状态；机器管理策略仍按 Codex 规则生效。凭据不进入 spec/workspace，原生进程可使用主机现有代理/CA 网络设置，代理值在实验原始记录中脱敏；工具环境排除 key/token/secret/password/proxy 和 CODEX_HOME；可识别的认证诊断在实验产物中打码。

登录查询调用原生 `codex login status`，仅识别认证类型，未报告的 planType 为 null。模型查询额外启动短暂的 stdio app-server，只发送 initialize/model-list 元数据请求，没有新建 thread 或模型推理。原生 app-server 没有 ignore-user-config 开关，会经过其配置加载；查询显式使用独立的官方认证路由并关闭用户扩展，临时 HOME/日志/状态在回收进程后删除，不启动常驻服务。查询默认 30 秒，执行前登录检查与版本探测共同计入任务时限。dry-run 仍然不启动任何进程、不读取认证、不加载 `.env`、不写入。

订阅报告以 `auth: "chatgpt"`、`provider: null` 标注；比较成功率、耗时和 token，费用保持未知，不将 API token 单价或原生零金额当作订阅账单。纯 API 报告格式保持不变；含订阅时 CSV 增加 auth 列。

认证与接口依据 [OpenAI 认证文档](https://learn.chatgpt.com/docs/auth) 和 [Codex App Server 模型目录](https://learn.chatgpt.com/docs/app-server#list-models-modellist)，执行参数按本机 `codex-cli 0.163.0-alpha.10.2` 的帮助和接口验证。

## Claude Code 订阅认证

Claude 订阅 backend 仅供 `claude-code` adapter 使用，不引用 `providers/`，要求显式模型。预置 `cc-claude-sonnet` / `cc-claude-opus` 使用原生 `sonnet` / `opus` 别名；别名的实际版本与账号权限由 Claude Code 决定，不视为固定版本。可另建 target 使用完整模型 ID：

```json
{
  "name": "cc-my-opus",
  "kind": "harness",
  "harness": "claude-code-write",
  "backend": { "auth": "claude-subscription", "model": "opus" }
}
```

```bash
npm start -- harness claude-code status
npm start -- harness claude-code status --json --claude-config-dir /path/to/native-claude-config
npm start -- targets init cc-my-opus --harness claude-code-write --auth claude-subscription --model opus
# 创建 Claude Code 的 API target 仍显式指定 provider：
npm start -- targets init cc-my-api --harness claude-code-write --auth api-key --provider anthropic --model <完整模型ID>
```

源定义只接受 `auth`、`model`、可选 `claudeConfigDir`，禁止混入 API 路由、价格和 Codex 参数。目录优先级为显式字段（相对项目根规范化）→ 当前 `CLAUDE_CONFIG_DIR` → `~/.claude`。环境中的 `CLAUDE_CONFIG_DIR` 要求绝对路径，并保留原字符串拼写及尾斜线以匹配原生认证命名空间。解析后冻结目录和 `claudeConfigDirMode: "explicit" | "default"`；该 mode 是快照字段，不能写入源定义。macOS 原生凭据命名空间会区分是否显式设置目录，即使路径同为 `~/.claude` 也不同。默认模式保留原 HOME 且不设置 `CLAUDE_CONFIG_DIR`；显式模式使用隔离 HOME 并传入冻结目录。实验室不解析、复制或导出凭据；原生刷新可能更新原配置状态，不能宣称整个 HOME 或认证状态完全隔离。

实现按 Claude Code 2.1.296 对照，任务执行版本门控要求 2.1.296 及以上；独立状态查询所需的目录元数据从 2.1.268 起提供。执行前调用原生 `claude auth status --json`，仅在 `loggedIn=true`、`authMethod="claude.ai"`、`apiProvider="firstParty"` 且 `configDirectory` 与冻结目录一致时继续。状态查询只返回白名单元数据，不输出身份标识、凭据或原始诊断；不符、缺字段或过旧版本即停止，不自动 login/logout，也不回退到 API key。状态检查和版本探测计入任务总预算；dry-run 不读取认证或启动 CLI。

启动使用 `--safe-mode` / `--restricted`、显式工具权限和空 MCP 配置，禁用个人定制；不能加会关闭 OAuth 认证的 `--bare`。默认认证模式仍需保留真实 HOME，原生 shell 快照初始化可能读取绝对路径下的 rc 文件；可信 `claude-shell.ts` 包装器在 macOS 使用 `sandbox-exec` 禁读这些启动文件，并以临时 shell HOME 和 `--noprofile --norc` 启动。其他平台无法提供此默认模式隔离时会停止，需先在独立的显式 `CLAUDE_CONFIG_DIR` 中用原生命令登录，再配置 target。包装器与可信设置放在本轮 home 并拒绝模型写入；原生工具沙箱与机器管理策略继续生效。模型始终使用选定 ID 或别名，不自动替换。

结果仍保存 tokens、耗时和完成/验收状态；`cost` / `costSource` 为 `null`，不会将 CLI 的 `total_cost_usd` 当作订阅实费。报告使用 `auth: "claude-subscription"`、`provider: null`，不应用 API 价格文件；API targets 与旧记录保持兼容。

依据 [Claude Code 认证](https://code.claude.com/docs/en/authentication)、[CLI 参数](https://code.claude.com/docs/en/cli-reference) 与 [沙箱说明](https://code.claude.com/docs/en/sandboxing)。本次接入按要求只做静态类型检查与代码审阅，不运行测试、状态查询、dry-run 或任务实验；上述示例不表示已确认本机订阅登录、模型权限或运行时隔离效果。

## Cursor Agent 原生服务

Cursor Agent 是独立 harness，通过 Cursor 服务执行，不组合 `providers/` 中的 DeepSeek、OpenAI 等接口。`cursor-agent` 为只读 profile，`cursor-agent-write` 为可写 profile；用户独立安装 CLI，项目不新增运行时依赖。适配按 Cursor CLI `2026.07.23-e383d2b` 源码核对并锁定此版本，其他版本需重新核对参数、认证与事件语义后接入。

预置 `cursor-auto` 使用原生登录，`cursor-api-auto` 使用 Cursor API key，两者均为可写。`auto` 允许原生自动选模；有固定模型需求时先查询目录，再创建显式模型 target：

```json
{
  "name": "cursor-my-model",
  "kind": "harness",
  "harness": "cursor-agent-write",
  "backend": { "auth": "cursor-login", "model": "auto" }
}
```

```bash
npm start -- harness cursor-agent status --json
npm start -- harness cursor-agent models
npm start -- targets init cursor-my-model --harness cursor-agent-write --auth cursor-login --model <目录中的模型ID>
# CURSOR_API_KEY 已在进程环境设置后：
npm start -- harness cursor-agent models --auth cursor-api-key --json
npm start -- targets init cursor-my-api --harness cursor-agent-write --auth cursor-api-key --model <目录中的模型ID>
# 后续使用现有任务流程，先查看计划，再正式执行：
npm start -- bench run --task fix-add --targets cursor-auto --dry-run
npm start -- bench run --task fix-add --targets cursor-auto --repeat 3
```

`harness cursor` 是查询命令别名；`status` / `models` 接受 `--auth cursor-login|cursor-api-key`、`--api-key-env` 和 `--json`。查询只输出安全元数据，区分凭据存在与原生验证结果，不判断订阅权益；动态模型目录也不是账号权益保证。指定模型原样传递，不自动回退或替换。`cursor-login` backend 仅接受 `auth/model`；`cursor-api-key` 另接受 `apiKeyEnv`，缺省 `CURSOR_API_KEY`。两个模式都拒绝 provider/protocol/baseURL/pricing、其他 harness 的目录和推理参数，不能把现有 DeepSeek provider 直接套入。

原生登录模式目前仅支持 macOS。预置 profile 显式设置 `useCurrentUserHomeForLogin: true`，让 Cursor 原生进程保留本机 HOME/USERPROFILE，以使用它自己的认证流程；配置、数据、XDG/cache 与工具 shell HOME 仍按运行隔离。由 Cursor 自己读取/刷新登录，不解析、复制或导出凭据；配置目录不用于选择账号。字段缺省/false 保留旧隔离行为；API key 模式始终使用隔离 HOME，不受此选项影响。原生 HOME 与模式写入实际 plan；可能读取本机 skills 或其他上下文，因此不等于完整 HOME 隔离。Linux 可使用 Cursor API key；任务执行的 shell 包装器要求 POSIX 平台。API key 由指定环境变量传入，使用原生内存凭据存储，不写入配置；缺凭据时失败，不自动登录、登出或切换认证。状态/模型查询不加载 `.env`，必须提前在进程环境中设置所需 key；bench 正式执行仍沿用统一密钥加载流程。dry-run 不启动 CLI、不读取认证。

任务使用非交互 `-p --output-format stream-json`、显式 `--model` 与 `--sandbox enabled`。只读 profile 增加 `--mode ask`，两种 profile 都设置工具白名单；仅信任本轮从冻结 fixture 建立的专属 workspace，不使用 force/yolo 跳过权限，也不自动批准 MCP。拒绝 workspace 中的 `.cursor` 配置路径，配置与数据目录保持隔离；原生登录保留本机 HOME，不能保证排除全部个人上下文。原生 CLI 仍可能从账号/团队下载 plugins、hooks 或托管 skills；不能宣称全部个人扩展已关闭，也不能把 Cursor 与其他 harness 的条件视为完全一致。工具权限和独立 HOME 不等于完整 OS 隔离。

可信 bash/zsh 包装器在 shell 启动前清除 key/token/secret/password/credential/proxy 环境变量，固定本轮 HOME 并跳过用户启动文件。包装器目录以只读方式交给原生沙箱；不配置会将命令升级到 `insecure_none` 的 `Shell(*)`，由原生沙箱策略自动批准范围内命令。该版本全局配置中的 `readBoundary` 不会完整传递，文件读取工具也不受 shell 沙箱统一约束；因此这里不承诺只能读取 workspace。账号/团队 hooks、plugins 与原生直接启动的其他进程不经过此 shell 包装器。

执行状态、最终答复、耗时与独立任务验收进入原有记录。当前原生事件的 token 字段可能缺省补零或漏计重试，无法证明完整推理/重试用量，因此统一 `usage`、`usageSource`、`cost`、`costSource` 都保持 `null`，原始 usage 事件保留供审计。初始化事件中的 model 是展示标签，不能当作实际响应模型，`responseModel` 同样为 `null`。报告标识 `auth: "cursor-login" | "cursor-api-key"`、`provider: null`，不应用 LLM API 价格，不把未知费用当免费；旧实验和 API provider 记录保持兼容。

参考 Cursor 官方 [参数](https://cursor.com/docs/cli/reference/parameters)、[认证](https://cursor.com/docs/cli/reference/authentication)、[配置](https://cursor.com/docs/cli/reference/configuration)、[权限](https://cursor.com/docs/cli/reference/permissions)、[输出格式](https://cursor.com/docs/cli/reference/output-format) 与 [Headless 模式](https://cursor.com/docs/cli/headless)。最初接入只做源码与静态检查；2026-10-18 后续连接修复已增加离线回归和当前设备的真实诊断，证据与兼容边界见下文。账号权限与网络状态仍以运行当次为准。

## 定义任务和验收

`tasks/<name>.json` 的 `name` 与文件名一致。`prompt` 和 `promptFile` 必须且只能提供一种；后者相对项目根，读取后保存文本快照。`fixture` 可选，为项目内的素材目录：

```json
{
  "name": "rewrite",
  "promptFile": "tasks/prompts/rewrite.txt",
  "fixture": "tasks/fixtures/rewrite",
  "timeoutMs": 120000,
  "checks": [
    { "kind": "output-contains", "text": "完成" },
    { "kind": "file-exists", "path": "result.txt" },
    { "kind": "file-contains", "path": "result.txt", "text": "expected" },
    { "kind": "command", "argv": ["node", "--version"], "timeoutMs": 10000 }
  ]
}
```

任务执行时限缺省 120000ms，包含直接模型的请求/退避，或 harness 的版本检查、Codex / Claude Code / Cursor 原生登录检查、运行及 OpenCode 会话后验；超时会取消直接请求，或终止并回收 harness 进程组。DeepSeek Harness / OpenCode / Cursor 执行在终止信号后另留 4000ms 给原生子进程清理（前两者原生约三秒），回收结束后才写最后快照或验收。其他进程默认宽限 200ms。Ctrl-C、SIGTERM 或主程序退出也会清理活动子进程。每个验收命令另外计时，缺省 10000ms。Windows 使用 Node 提供的子进程终止，POSIX 使用进程组终止；这套实验室以本地 macOS/Linux 为主要环境。

验收命令以 argv、无 shell 运行，工作目录是该次采样的 workspace，不继承模型密钥。非零退出表示断言失败，无法启动或超时表示检查器错误。验收定义来自可信任务文件，尽量将断言直接写在任务 argv 或不可被实验对象改写的位置；不要让 agent 编辑过的测试文件成为唯一判断标准。

直接 LLM 只看到 system 与 prompt，不自动读取 fixture、不附加工具循环，因此不能完成需要修改文件的任务。回答类任务适合与直接模型对照；文件任务应选择允许写入的 harness profile。示例 `fix-add` 的断言固定在任务定义中，检查正数、负数及零。

新增 `fix-order-total` 和 `normalize-orders`，两题执行预算均为 300000ms：

| 任务 | 工作内容 | 独立验收 |
| --- | --- | --- |
| `fix-order-total` | 按 SPEC 修复五个 ESM 模块中的金额、折扣、运费和汇总错误 | 模块边界、完整订单、非法输入、输入不变、CLI，以及只修改允许文件 |
| `normalize-orders` | 编写可复用生成脚本，从 CSV 和客户 JSON 生成三个输出文件 | 完整结构/值/排序、输入与 SPEC 未改，以及更换数据后重跑 |

可信 checker 的源文件位于 `tasks/checks/`，完整源码同时固定在任务 JSON 的 command argv。它不随 fixture 复制，不依赖 harness 可修改的测试文件。对应回归验证初始任务失败、参考实现通过、典型错误与改输入作弊失败。多文件 fixture 永远保留待修状态，数据 fixture 不预置生成器或成品。

Pro targets 为 `cc-ds-pro` / `codex-ds-pro`，Flash 为 `cc-ds-flash` / `codex-ds-flash`，全部使用同一个 `deepseek` provider，模型分别是 `deepseek-v4-pro` / `deepseek-flash`。仅切换模型后，可对每题分别 `--repeat 3 --concurrency 6`，先 Pro 后 Flash，共 24 次。通过率以全部三次为分母，超时、启动失败和断言失败都保留；不通过补跑替换不利样本。六路同时运行可减少启动顺序差异，但共享后端负载仍会影响耗时。比较的是完整执行组合，默认提示、协议和推理设置尚未统一。

## 隔离和可复现信息

任务开始先冻结 fixture；所有 target × repeat 从冻结源独立复制。清单记录排序后的路径、内容 SHA-256、字节数与文件模式，整体 hash 纳入 spec。后续修改源 fixture 不影响正在运行的实验。文件改动在执行结束、验收开始前取快照，检查器生成的日志或构建产物不计入 target 的改动。

复制跳过 `.git`、`node_modules`、`archives`、`.env` 和 `.env.*`（保留 `.env.example`），拒绝符号链接和项目外的 fixture/promptFile。每次采样有独立工作区，API targets 另有独立 HOME 与配置目录；原生登录 targets 按前述边界复用认证，不修改父进程环境。Claude Code 通过纯净设置、工具列表和非交互权限启动，Codex 使用临时会话与沙箱，API 模式显式配置 Responses provider。原有四种 adapter 禁用个人 MCP、skills 或记忆，也不读取实验室祖先 AGENTS 作为任务输入；Cursor 的远端账号/团队扩展边界见上节。

DeepSeek Harness 以 `--profile headless --json -` 接收 stdin 任务，显式 profile 仅含官方 base/headless 两个 bundles；独立 DSH_HOME 与 AGENTS_HOME。禁用遥测/OTel、指令/skills 扫描、插件管理、额外模型路由、标题模型、web 工具及委派/PTC 工作流；模型凭证通过独立环境变量传入，原生 subprocess 层会过滤含 KEY/TOKEN/SECRET/PASSWORD 的变量。写入通过原生 sandbox-policy 限于 workspace，approval=never，不等待交互审批；只读 profile 还禁用 shell。headless 不启动 UI、HTTP 服务或监听端口。

OpenCode 使用 V2 的 `run --standalone --format json`。上游会为本次运行创建私有 `serve --stdio` 子进程，随 run 退出，不连接用户的已有会话或服务。每次使用独立 HOME/XDG/OPENCODE_CONFIG_DIR，禁用户/项目配置加载、Claude 兼容指令、skills、MCP、自动更新和模型目录抓取；显式禁用内置 title/summary agent，避免附加模型调用干扰用量。模型工具只允许本地读操作，可写 profile 增加 edit/shell，并拒绝外部目录。唯一放行的本地插件由实验室生成，在 shell 启动前清除含 KEY/TOKEN/SECRET/PASSWORD 的变量和 OPENCODE_CONFIG_CONTENT，不含 API key 文件或运行时依赖。OpenCode 上游的机器管理策略仍会生效，这些策略可能进一步限制本次任务。

这些是目录与 harness 原生权限边界。尤其 OpenCode 的工具规则不是操作系统沙箱；独立 HOME 或禁止外部目录工具，不保证模型执行的 shell 被 OS 隔离。harness 自身的内置提示、工具实现与系统环境仍会影响结果；记录 CLI 版本有助于复查，版本本身不能使模型服务端固定。

## 结果格式

```text
data/benchmarks/<b_id>/
  spec.json                         schemaVersion=1，解析后任务/targets、repeat、fixture hash
  report.md                         每次采样的执行与验收、版本、统计与产物链接
  fixture/                          冻结的初始素材
  variants/<target>/run-<n>/
    record.json                     完整执行、验收、改动与路由快照
    output.md                       最终答复
    events.jsonl                    归一化事件，未知事件作为 raw 保留
    stdout.log / stderr.log         CLI 原始流（脱敏后）
    changes.json                    added / modified / deleted 与前后 hash
    workspace/                      本次产物
    home/                           本次 harness 的配置/状态
```

执行状态：`completed` / `failed` / `timeout`。验收状态：`passed` / `failed` / `not-run` / `error`。只有 CLI 正常结束并收到协议成功终态才算完成，截断或非法 JSONL 失败。DeepSeek Harness 必须同时有 opening session、`turn_end.reason.kind=completed`、末尾 `final` 和 exit 0。OpenCode V2.0.32 的 JSON 消费端可能在快速响应时漏发最后的 `step_finish`；每次正常运行后用官方 `session export --standalone <sessionID>` 核验原生成功终态、最终 assistant.stop/completed、任务输入、workspace 和 backend 一致，并从导出恢复完整答案。该检查不带模型凭据、不调用模型，共享原任务剩余预算；导出失败或超时则该次不算完成，原流的错误或非法 JSON 不因导出成功而变成成功。单纯工具步骤或 EOF 不算成功。验收只对完成的执行进行；无 checks 为 `not-run`。

`usageSource` 区分直接调用 `request` 与 harness 累计 `run-total`。CLI 未提供的 usage/cost 为 null，不能按零比较；累计计数不重复累加每条中间消息。`costSource` 为本地 `configured-pricing` 或 `harness-reported`；仅提供总价时输入/输出部分为 null。不同币种不汇总，第三方后端的 CLI 报价须以实际账单为准。

DeepSeek Harness 的 `step_end.usage` 已包括该步骤的重试尝试；逐步汇总，任一步缺 usage 则总量未知。其 `inputTokens` 不含缓存读取/创建，归一化 prompt 为 input+cacheRead+cacheWrite；output 已含 reasoning，不再加一次。OpenCode 原流按步骤 ID 去重，后验以官方会话导出的累计 tokens 为准，不与原流再次相加；prompt=input+cache.read+cache.write，completion=output+reasoning。缺计数或出现委派时不把父会话用量冒充总量。DeepSeek Harness / OpenCode 的当前输出不提供可证明的实际响应模型，`responseModel=null`；所选模型仍保存在 target 快照。两者 `cost=null`，OpenCode 为未知自定义模型合成的零价不当成实际费用，原始字段仍保留在事件中。

2026-10-17 本地真实冒烟已验证两种新 harness 的 Pro/Flash 连通和文件修复：DeepSeek Harness 的 `hello` 为 `b_d10293e5fe`（Flash）与 `b_e415424cf9`（Pro），Flash `fix-add` 为 `b_1999f8f7d0`，Pro `fix-add` 为 `b_e938c7a7f5` 内对应一路；OpenCode 关闭 title/summary 后，双模型 `hello` 为 `b_ed97346a80`、双模型 `fix-add` 为 `b_46b6479f03`。最终八个组合均收到可信完成终态并通过独立验收。这些是接入冒烟，每种组合每题一次，不能据此比较质量；早期暴露版本字符串与 OpenCode 结束事件问题的失败记录，以及关闭辅助 agent 前的验证记录也保留在本地。

原始请求/响应位于 `record.execution.raw`，包含实际启动计划（参数、路由、配置文件内容与脱敏后的环境）、版本探测与子进程输出。CLI stdout/stderr 与归一化事件单独保留；已设置的 API key/token 会在结果序列化时打码。`bench` 不套用旧会话树或 `compare score`，也不自动重跑整个 harness 任务。每个新实验按当前任务定义重新冻结素材，旧实验保留不改写；此阶段不提供续跑/恢复命令。

## 扩展点

### 从模板增加任务

```bash
npm start -- tasks init csv-merge --template data
npm start -- tasks validate csv-merge
npm start -- tasks validate --all
```

模板有 `repair`、`data` 和 `answer`。`init` 生成 `tasks/<name>.json`、`tasks/prompts/<name>.md`、`tasks/fixtures/<name>/SPEC.md` 和素材；修复、数据模板还生成 `tasks/checks/<name>.mjs` 与 fixture 外的 `tasks/self-tests/<name>/` 参考/负例目录。回答模板直接声明参考和错误答案。所有目标路径先预检，已有文件、同名素材目录或符号链接都会拒绝，禁止覆盖现有题目。

新任务可写成下面的形式；这些字段均可选，旧任务的内嵌 command 不需要迁移：

```json
{
  "name": "csv-merge",
  "promptFile": "tasks/prompts/csv-merge.md",
  "fixture": "tasks/fixtures/csv-merge",
  "timeoutMs": 300000,
  "requires": "workspace-write",
  "checks": [
    { "kind": "script", "file": "tasks/checks/csv-merge.mjs", "timeoutMs": 10000 }
  ],
  "manifest": {
    "immutable": ["SPEC.md", "inputs/**"],
    "editable": ["transform.mjs", "outputs/**"],
    "allowNewFiles": true
  },
  "selfTest": {
    "initial": "fail",
    "reference": { "files": "tasks/self-tests/csv-merge/reference" },
    "negative": [
      { "name": "wrong-total", "files": "tasks/self-tests/csv-merge/negative-wrong-total" }
    ]
  }
}
```

`script.file` 必须是项目内的可信 `.mjs`，加载时读取并展开为 `node --input-type=module -e <完整源码>`。实验 spec 保存展开后的命令，后续修改或删除原 checker 不会改变已冻结实验的验收。脚本以候选 workspace 为当前目录，所需辅助验收代码应自行包含在源码中；不要依赖相对 import 去读取候选提供的检查器。`output-equals` 对输出和期望文本去除首尾空白后精确比较；原 `output-contains` 行为保留。

`manifest` 支持精确文件路径与 `dir/**`。`immutable` 匹配的现有素材按内容和文件模式冻结；若提供 `editable`，其他所有现有文件也会冻结。新增文件缺省允许，但提供了 `editable` 时仍须匹配它；`allowNewFiles:false` 禁止所有新增文件。不可修改与可编辑范围不得重叠，不允许符号链接。约束从加载时的 fixture 计算并展开为可信命令进入快照，无需手填 hash。`requires:workspace-write` 让预检提前拒绝直接 LLM 和只读 harness；旧题未声明时保留原行为。

`selfTest` 的 `files` 是相对项目根的 overlay 目录，覆盖到临时 fixture 副本；与 fixture 不能包含或重叠。文本题用 `output` 提供模拟最终答案。`validate` 分别运行初始状态、参考解与每个负例，各有独立临时工作区并在结束后清理；只有预期失败实际为 `failed` 才算负例有效，检查器超时或基础设施错误不算正确拒绝。没有 `selfTest` 的旧题只报告结构校验，并明确提示未运行参考解/负例。此命令不加载 `.env`，不调用模型或 harness。模板只是起点，编辑题面、素材、验收和对应自测后再执行实验。

### 多任务实验套件

`bench-suites/` 与文本比较使用的 `suites/` 分开。预置 `smoke` 为连通与简单修复，`harness-regression` 为多文件修复、数据整理两题与四种 Flash harness。增减任务或显式 target 只需编辑套件文件：

```json
{
  "name": "harness-regression",
  "tasks": ["fix-order-total", "normalize-orders"],
  "targets": ["cc-ds-flash", "codex-ds-flash", "dsh-ds-flash", "opencode-ds-flash"],
  "repeat": 3,
  "concurrency": 3
}
```

```bash
npm start -- bench suites ls
npm start -- bench suites show harness-regression
npm start -- bench run --suite harness-regression --dry-run
npm start -- bench run --suite harness-regression
npm start -- bench run --suite harness-regression --timeout-ms 600000
npm start -- bench run --task normalize-orders --targets cc-ds-pro --repeat 3 --timeout-ms 600000 --dry-run
```

套件缺省 `repeat=3`、`concurrency=3`；原单任务缺省重复 1 次不变。`--suite` 与 `--task` / `--targets` 互斥。任务条目也可写 `{ "name":"normalize-orders", "timeoutMs":600000 }`，套件顶层可写 `timeoutMs`。预算覆盖顺序为 CLI > 套件全局 > 套件单题 > 源任务；覆盖只写本轮快照，不改源文件。`--repeat` 和 `--concurrency` 覆盖套件定义。

预检一次展开全部样本并检查题目、路由和素材，dry-run 无密钥、无 CLI 进程且不落盘。正式执行先冻结全部任务，再共享一个全局并发池；任务和 targets 交错调度，实际完成先后不改变报告顺序。每次采样的独立 workspace/home、可信完成终态和验收逻辑继续沿用。失败样本保留，不自动重跑。

```text
data/benchmarks/e_<id>/
  spec.json     kind=suite，完整子 BenchSpec、子 b_id 与确定的调度顺序
  state.json    planned/running/completed/interrupted/incomplete 与已记录采样数
data/benchmarks/b_<id>/
  ...           原有 schemaVersion=1 单任务记录和独立冻结 fixture
```

`bench ls` 同时列实验组和原单题，`bench show <e_id>` 查看组报告。运行阶段逐样本更新状态；进程被强制停止时可能留下 running 状态和缺失样本，离线报告仍按完整计划列出缺失。当前不提供恢复或自动补跑。

### 统一离线报告与费用重算

```bash
npm start -- bench report <e_id>
npm start -- bench report <b_id1> <b_id2> --format json
npm start -- bench report <e_id> --format csv --output data/tmp/results.csv
npm start -- bench report <e_id> --pricing data/tmp/prices.json --scenario offPeak
```

报告只读取冻结 spec 和 record，不要求当前任务、素材、provider 或 target 文件仍然存在，也不会重新执行候选代码或检查器。唯一 `b_id/target/sample` 去重，父组与显式子 ID 重复输入不会重复统计。计划样本、已记录、执行完成/失败/超时/缺失、验收失败/错误/未运行分别列出。耗时同时给全样本与成功样本的均值、最小和最大，用量按覆盖数统计，缺失字段保留未知。

套件按任务等权汇总，避免某题重复次数多就获得更高权重。不同父组和裸 b_id 分轮次展示；同名任务但题面/checker/fixture/预算不同、target 实际配置或 harness 版本不一致时不静默合成可比排名。JSON 保留完整条件与逐次数据，Markdown 供阅读，CSV 供进一步统计。`--output` 只创建指定的新文件，拒绝覆盖；不改原来的 report、spec 或 record。

价格文件由用户维护，格式如下。示例中的 provider、model 和数值只演示结构，不代表任何实际模型价格；应替换为用户确认的来源和单价，仓库不预置价格文件。

```json
{
  "currency": "CNY",
  "verifiedAt": "2026-10-18",
  "sources": [{ "title": "用户确认的价目表", "url": "https://example.test/pricing" }],
  "models": [{
    "provider": "your-provider",
    "model": "your-model",
    "scenarios": {
      "offPeak": { "inputPerMillion": 1, "cachedInputPerMillion": 0.1, "outputPerMillion": 2 },
      "peak": { "inputPerMillion": 2, "cachedInputPerMillion": 0.2, "outputPerMillion": 4 }
    }
  }]
}
```

每项单价的单位均为每百万 token；模型条目可单独声明 `currency`，不同币种不合并。匹配使用明确的 provider 和请求 model，不猜别名或汇率。缺省列全部情景；`--scenario` 显式选一种，不按当前时间推断峰谷或节假日。报告保存解析后的价格快照、来源、核对日期与原文件 hash。

估算公式为 `(命中输入×缓存价 + 未命中输入×输入价 + 输出×输出价)/1,000,000`。输出已经包含推理，不额外加 reasoningTokens；Codex 未命中字段缺失时可从总输入减命中计算。没有缓存价表示统一输入价；有缓存价但缺命中计数时给全命中/全未命中的上下界。完整 usage 缺失或没有该模型价格时保持未知，只有已知费用下限，不能补零。每成功交付成本使用全部尝试费用除以通过数，包括失败花费；有尝试缺用量时不计算完整交付成本。没有价格文件时不做重算，原生报价按来源与币种单列，保留原记录，不当作另一 provider 的账单。

`src/lib/bench/executor.ts` 统一返回 ExecutionResult；直接模型复用 Completer，工具执行通过 ProcessRunner 注入。新 harness 应增加自己的协议匹配、启动计划和事件解析，不应变成 provider。任务验收由独立 grader 执行，模型裁判、更多评分与显式 bridge 可在后续扩展。

实现参考本地 open-science 的 framework / backend route 分层，以及 [Claude Code 非交互文档](https://code.claude.com/docs/en/headless)、[Claude Code 沙箱文档](https://code.claude.com/docs/en/sandboxing)、[Codex 非交互文档](https://developers.openai.com/codex/noninteractive) 和 [Codex 配置参考](https://developers.openai.com/codex/config-reference)。DeepSeek Harness 的接口按官方 [headless 源码与契约](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless) 及 npm 0.2.0-rc.2 发行包核对；OpenCode 按官方 [源码仓库](https://github.com/anomalyco/opencode) 与 [V2 CLI 发行包](https://www.npmjs.com/package/@opencode/cli/v/2.0.32) 核对。上游 master 会变化，以实际记录的 CLI 版本及本次运行产物为准。

### Cursor 代理传输（2026-10-18）

profile 可选 `useHttp1ForAgent: true|false`，仅 Cursor 接受。预置 Cursor profile 开启 HTTP/1.1 SSE，写入原生 `network.useHttp1ForAgent`；旧定义不写此字段时保留原生默认。Cursor 进程启用 `NODE_USE_ENV_PROXY=1`，shell 包装器保留标准八个代理变量，其余凭据清理规则不变，带认证代理沿用统一脱敏。不会修改系统代理或禁用证书验证。参考 [Cursor 官方代理配置](https://prod.cursor.com/docs/cli/reference/configuration)。

实测本机隔离 HOME/PATH 会影响原生登录。通用 profile 已通过显式 `useCurrentUserHomeForLogin` 和独立原生 launcher 修复：认证查询与执行使用相同的 HOME 规则，工具包装器只作用于后续模型 shell。单次完整权限实验另保留原生 PATH/工具 HOME，沿用用户选择的权限；会暴露本机技能上下文，不能把它当作完全隔离运行。通用 profile 仍保留原有沙箱与工具权限约束。移除账号/模型可能不支持的 `--exclude-workspace-context`；原生上下文可能包含父仓库。

原图连接故障进一步定位为原生消息等待阈值：固定版本只在收到完整协议消息后重置默认 30 秒计时，持续接收一个大图片帧也可能被判定停滞。实测原图传输仍持续收包，在约 395 KB / 417 KB 处被取消并重连；单独放宽内部阈值后，同一 Opus 5.5 high 完成原图 Read、后续 Shell 和最终成功结果。HTTP/1.1 和升级 CLI 本身不足以解决此故障。

`nativeStallTimeoutMs` 是本项目的兼容选项，**不是 Cursor 官方参数**。范围为 30000–300000 整数，预置两套 profile 为 300000，给接近 1 MiB 的原生图片消息留出传输余量。`cursor-runtime.ts` 的 preload 先核验 `2026.07.23-e383d2b` 原始入口完整 SHA-256 及唯一源码锚点，再仅在内存中替换默认等待值；任一不匹配立即失败。安装不变，总任务预算继续由统一执行层控制；不改模型、提示词、图片质量或权限。`home/cursor-runtime/compatibility.json` 和原始 plan 保存补丁 ID、源 hash、等待时间及 preload 内容，便于区分未经修改的原生 CLI；旧实验不回写，旧 profile 缺字段不启用。

原生入口通过绝对系统 bash 启动，避免 `#!/usr/bin/env bash` 误入工具包装器而清掉认证上下文/preload。版本与认证探针保持原生流程且不带补丁，preload 在运行入口前恢复加载器、移除自身 NODE_OPTIONS，模型启动的 Node 子进程不继承它。离线回归覆盖 hash/入口/锚点拒绝、子进程环境、launcher 与 shell 隔离，禁止拿真实服务作为单测。

2026-10-18 集成后实测 `b_1c479e305e`（`e_ff7ddd2a9d`）：请求 `claude-opus-5-5-high`、完整工具权限，4 张原始参考图逐一 Read + 后续 Shell 全部完成，562.804 秒正常退出，无重连/错误事件，stderr 为空，素材 hash 未变。这是连接诊断，`checks=[]` / `grade=not-run`，不是视频质量评测。另有 346 项全量离线测试及 typecheck 通过。较大图片传输仍偏慢，兼容修复保证等待余量，不代表带宽改善；正式视频仍沿用原提示词和总时限，需单独运行。
