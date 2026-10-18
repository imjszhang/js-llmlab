# DeepSeek 官方 API 能力

核对日期：2026-10-17。默认官方 provider 为 `deepseek`，使用环境变量 `DEEPSEEK_API_KEY`；不要把密钥放进请求文件。`api` / `deepseek` 命令不依赖会话树，原始材料独立写入 `data/api/<api_id>/`。

## 模型及适用范围

- `deepseek-flash`：DeepSeek-V4.1-Flash-1017，支持文本、图片，思考与非思考模式。
- `deepseek-v4-pro`：DeepSeek-V4-Pro-0813，支持文本，思考与非思考模式。Responses 服务端 `web_search` 仅此模型支持。
- 两者上下文为 1M，最大输出 384K；FIM 单次补全上限单独为 4K，仅支持非思考。
- `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已映射到最新 Flash，不能用旧名字固定历史版本。记录实验结论时同时注明实验日期及官方实际版本。

`run` / `compare` 适合会话树和多配置实验；下列原始 API 入口用于完整官方协议，包括工具结果回传、图片、结构化输出和新字段。模型返回的 `function_call`、`tool_use`、`apply_patch` 等只保存或输出，不会执行本地工具或命令。

## 通用选项与输出

```bash
npx tsx src/cli.ts api chat --request data/tmp/chat.json --dry-run
npx tsx src/cli.ts api responses --request data/tmp/responses.json --config ds-official-pro-reason --stream
npx tsx src/cli.ts api messages --request data/tmp/messages.json --json
```

`--request` 接受 JSON 文件路径或内联 JSON 对象。全部协议字段原样保留；只为缺失字段补入配置默认值：模型、输出上限、协议对应的思考/effort 参数。显式 `--model`、`--stream` 覆盖请求中的对应字段。Responses 中配置 `thinking: disabled` 会转为 `reasoning.effort: "none"`，启用思考且无 effort 时用 `high`。

通用参数：

| 参数 | 行为 |
|---|---|
| `--config <name>` | 命名配置或模型 ID；已指定配置时遵循它的 provider |
| `--provider <name>` | 显式覆盖 provider；未给配置时默认 `deepseek` |
| `--model <id>` | 显式覆盖请求模型 |
| `--timeout-ms <n>` | 请求超时，覆盖网络连接及完整响应读取 |
| `--max-retries <n>` | 只重试 HTTP 408 / 429 / 5xx；上传文件不自动重试，开始消费 SSE 后不自动重试 |
| `--headers <json>` | 额外请求头 JSON 对象或文件；不能覆盖认证、host 或内容类型 |
| `--dry-run` | 无密钥预览；不发请求、不落盘 |
| `--json` | stdout 输出完整响应 JSON；SSE 输出 `{response, events}` |

普通模式 stdout 是正文；没有正文（例如只请求工具）时输出完整 JSON 或 SSE 事件，便于继续回传。记录目录打印到 stderr。SSE 中的推理、工具参数、usage、终止及失败事件均保留。网络错误、HTTP 错误、流错误或提前断流也会保存已收到的材料，命令失败退出。Chat 的 `finish_reason` 为 `aborted` / `insufficient_system_resource` / `content_filter` 时同样按失败保存，已有正文保留，不自动重跑。终端及落盘内容都会打码当前 API key。

显式 provider 的 `baseURL` 路径会保留，包括第三方网关的 `/v1` 或 `/proxy/v1`；拼接端点时只去除重复的路径前缀。仅官方 `api.deepseek.com` 的 `/v1` / `/beta` / `/anthropic` 已知入口会按所选协议归一。

落盘包括：`request.json`（无认证头）、`response.json`、`events.json`、`response.txt`（响应原文）、`meta.json`（状态、耗时、request id、尝试次数、错误）。发生 HTTP 错误时另存 `attempt-<n>.json`。这些运行产物不提交 Git。

## Chat Completions、JSON Output、工具调用和前缀续写

```json
{
  "model": "deepseek-flash",
  "messages": [{"role": "user", "content": "只输出 JSON，给出 name 字段。"}],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high",
  "response_format": {"type": "json_object"}
}
```

```bash
npx tsx src/cli.ts api chat --request data/tmp/chat.json
npx tsx src/cli.ts api chat --request data/tmp/chat.json --stream --json
```

工具定义放 `tools`，选择策略放 `tool_choice`。多轮请求的 `messages` 可包含 assistant 原始 `tool_calls` / `reasoning_content` 以及 role=`tool` 的结果。思考模式配合工具时，必须完整保留官方响应中的历史 `reasoning_content`；本工具不会执行工具或自动构造下一轮。

前缀续写在末条 assistant 消息设 `prefix: true`，使用 `--beta`；严格工具 schema 同样使用 Beta 入口：

```json
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "user", "content": "写一段 Python 排序代码"},
    {"role": "assistant", "content": "```python\n", "prefix": true}
  ],
  "thinking": {"type": "disabled"},
  "stop": ["```"]
}
```

```bash
npx tsx src/cli.ts api chat --beta --request data/tmp/prefix.json
```

思考模式默认开启，默认 effort=`high`，可选 `low` / `high` / `max`。思考时 `temperature` 不生效。`top_p` 的生效方式依模型及模式不同，详见官方兼容性说明。

## 图像理解

仅 Flash 支持。Chat 使用 user 内容块：

```json
{
  "model": "deepseek-flash",
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "解释图表"},
    {"type": "image_url", "image_url": {"url": "https://example.com/chart.png", "detail": "low"}},
    {"type": "file", "file_id": "file-api-EXAMPLE"}
  ]}]
}
```

`image_url.url` 也可为 `data:image/png;base64,...`；`file` 可用 `file_id`，或互斥的 `file_data`（data URL，可附 filename）。支持 JPEG、PNG、GIF、WebP，格式由内容判断。`detail` 可选 `low` / `high` / `original` / `auto`；`low` 缩至 512×512，其余当前保留原图。

限制：请求体 48 MiB；单张内联/URL 32 MiB，Files 引用 64 MiB；每次最多 600 张；不含 Files 图片总计 64 MiB，含 Files 最高 200 MiB；图片最长边 8192 像素，15 张及以上时降为 4096。图片 URL 最长 8192 字符。Chat 图片只能放 user 消息，不能放 system / assistant。

## Responses API

```json
{
  "model": "deepseek-v4-pro",
  "instructions": "回答时引用搜索到的来源。",
  "input": "DeepSeek 今天有哪些更新？",
  "reasoning": {"effort": "high"},
  "tools": [{"type": "web_search"}],
  "max_output_tokens": 8192
}
```

```bash
npx tsx src/cli.ts api responses --request data/tmp/responses.json --stream
```

支持字符串或 item 数组 `input`、function 工具、Pro 的服务端 `web_search`，以及专供兼容用途的 `custom` / `apply_patch`。Flash 会忽略 `web_search`；其他 custom 工具名称报 400，`file_search` / `code_interpreter` / `computer_use` / `mcp` 等不受支持。工具结果由调用者填入下一次 `input` 的 `function_call_output` / `custom_tool_call_output`，可完整回传上次 output 中的工具、reasoning、web_search_call items。

接口无状态，不支持 `previous_response_id` / `conversation` / `store` / `background`。`metadata`、`include`、`stream_options` 等字段会被官方静默忽略。每次需显式提交完整输入历史；缓存由服务端自动管理。流以 `response.completed` / `response.incomplete` / `response.failed` 事件结束，不用 `[DONE]`。

Flash 图片使用 `input_image`，`image_url`（URL 或 data URL）与 `file_id` 二选一；允许 user / developer 消息，以及工具输出中的图片，system / assistant 不允许。普通文档文件输入不支持。

```json
{
  "model": "deepseek-flash",
  "input": [{"role": "user", "content": [
    {"type": "input_text", "text": "这张图片有什么？"},
    {"type": "input_image", "file_id": "file-api-EXAMPLE"}
  ]}]
}
```

## Anthropic 兼容 Messages

```json
{
  "model": "deepseek-flash",
  "max_tokens": 4096,
  "system": "准确简洁地回答。",
  "messages": [{"role": "user", "content": [{"type": "text", "text": "你好"}]}],
  "thinking": {"type": "enabled"},
  "output_config": {"effort": "high"}
}
```

```bash
npx tsx src/cli.ts api messages --request data/tmp/messages.json --stream
```

实际路径 `/anthropic/v1/messages`，自动带 `x-api-key`、`anthropic-version` 和 Files beta 头。支持 `tool_use` / `tool_result` 及图片 `source.type=base64|url|file`；file 引用需 `anthropic-beta: files-api-2025-04-14`（命令已自动设置）。图片 source 用 `file_id`、`url` 或 base64 的 `media_type` / `data`，与 Chat 格式不同。

`thinking.budget_tokens`、`top_k`、cache_control 等会被忽略；`document`、`redacted_thinking`、MCP/代码执行内容块不支持。`claude-opus*` 模型名映射 Pro，其他 `claude*` 映射 Flash，实际按对应 DeepSeek 模型收费。

## FIM 中间补全

```json
{
  "model": "deepseek-flash",
  "prompt": "def fib(a):",
  "suffix": "    return fib(a-1) + fib(a-2)",
  "max_tokens": 128
}
```

```bash
npx tsx src/cli.ts api fim --request data/tmp/fim.json
```

使用 `/beta/completions`。仅非思考模式，补全最多 4096 tokens；不要将模型一般的 384K 输出上限应用到 FIM。请求未指定上限时，配置值最多补入 4096。

## Search、Fetch、模型和余额

```bash
npx tsx src/cli.ts deepseek search 'DeepSeek site:github.com after:2026-10-01' --request '{"count":5,"need_content":true}'
npx tsx src/cli.ts deepseek search --request '{"query":"DeepSeek","count":10,"ori_question":"官方最近更新了什么？","localization":"","need_content":false}'
npx tsx src/cli.ts deepseek fetch 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
npx tsx src/cli.ts deepseek fetch --request '{"url":"https://example.com/article"}' --json
npx tsx src/cli.ts deepseek models
npx tsx src/cli.ts deepseek balance
```

Search 为 `/v1/tools/search`，Fetch 为 `/v1/tools/fetch`。Search 的 query 为 1–128 个 Unicode 字符，count 1–50；支持 `site:` / `-site:` / `lang:` / `before:` / `after:`、引号及排除词语法。Fetch URL 最长 8192 字符，只接受含 host 且无用户名/密码的 HTTP(S) 地址。Search 默认输出完整结果 JSON；Fetch 默认输出 Markdown 正文，`--json` 保留标题及其他响应字段。

Search / Fetch 都是独立计费 API，当前人民币 5 元 / 千次成功请求。通过官方 Agent 集成走服务端工具调用的这部分请求将于北京时间 2026-11-01 00:00 开始计费。模型使用中的服务端搜索计费应以官方最新说明为准。

## Files：上传、分页列表、查询、删除

```bash
npx tsx src/cli.ts deepseek files upload data/tmp/chart.png
npx tsx src/cli.ts deepseek files upload data/tmp/chart.png --request '{"purpose":"user_data","expires_after":{"anchor":"created_at","seconds":3600}}'
npx tsx src/cli.ts deepseek files list --request '{"after":"file-api-CURSOR","limit":20,"order":"desc","purpose":"user_data"}'
npx tsx src/cli.ts deepseek files get file-api-EXAMPLE
npx tsx src/cli.ts deepseek files delete file-api-EXAMPLE
```

上传以 multipart 发送，`purpose` 默认为 `user_data`。也可在 `--request` 的 `file` 字段提供本地文件路径。过期时间需同时给 anchor=`created_at` 与 seconds（3600–2592000），不传即永久保存。文件最大 64 MiB，文件名最长 512 字节；按文件头检查 JPEG/PNG/GIF/WebP。每账户最大 25 GiB / 10000 个文件。

官方 Files 用于图片理解，不是 PDF / Word 文档上传或通用文件搜索。当前官方没有公开文件内容下载端点，所以这里不提供 `files content`。同账户不同 API key 及两种协议共享上传文件。

Anthropic 兼容 Files：

```bash
npx tsx src/cli.ts deepseek files upload data/tmp/chart.png --anthropic
npx tsx src/cli.ts deepseek files list --anthropic --request '{"after_id":"file-api-CURSOR","limit":20}'
npx tsx src/cli.ts deepseek files get file-api-EXAMPLE --anthropic
npx tsx src/cli.ts deepseek files delete file-api-EXAMPLE --anthropic
```

这时使用 `/anthropic/v1/files`，自动带 Files beta 头；列表游标为互斥的 `after_id` / `before_id`，不支持 order/purpose；返回字段遵循 Anthropic 格式（size_bytes、type、RFC3339 created_at）。OpenAI 格式为 bytes、object、Unix created_at。

## 官方来源

- [模型、版本与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
- [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)
- [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)
- [工具调用](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)
- [前缀续写](https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion/)
- [FIM](https://api-docs.deepseek.com/zh-cn/guides/fim_completion/)
- [Responses 兼容性](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [Anthropic 兼容性](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)
- [Files 指南（含 Anthropic 格式）](https://api-docs.deepseek.com/guides/files_api/)
- [文件上传 Reference](https://api-docs.deepseek.com/zh-cn/api/create-file/)
- [Search / Fetch 指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search Reference](https://api-docs.deepseek.com/zh-cn/api/search/)
- [Fetch Reference](https://api-docs.deepseek.com/zh-cn/api/fetch/)
- [上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)

## 会话树中的工具结果续接

```bash
npx tsx src/cli.ts run --config ds-official-flash-reason --message '查询天气，请使用工具' --tools data/tmp/tools.json
npx tsx src/cli.ts node show <session> <node> --json
```

从节点的 `messages.apiMessages` 取出完整数组，追加每个工具调用对应的 `{"role":"tool","tool_call_id":"原调用id","content":"工具结果"}`，保存为 `data/tmp/results.json`，然后：

```bash
npx tsx src/cli.ts run --config ds-official-flash-reason --session <session> --messages data/tmp/results.json --tools data/tmp/tools.json
```

保留历史中的 `tool_calls` 和 `reasoning_content`。`--messages` 是完整协议输入，不会再额外追加一个空 user；`run` 的 stdout 仍只有成稿。前缀续写的 stdout 是新生成的追加内容，下一轮历史会自动恢复「原前缀 + 追加内容」。

Chat 的 `response_format` 仅支持 `text` / `json_object`；严格 JSON Schema 用工具的 `function.strict`（Beta）。Responses 的 `text.format` 支持完整结构化输出格式，可直接写在原始请求中。Chat 的 `user_id` 用于用户与缓存隔离，Responses 对应 `user`。新参数可通过原样请求入口传递，不需修改 SDK 类型。
