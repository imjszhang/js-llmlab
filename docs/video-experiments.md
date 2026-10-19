# 视频实验执行与离线评审

更新：2026-10-19。

正式配置取代临时启动脚本。任务提示、样式 fixture、可信验收保持不变；候选自行安装依赖、渲染和自检。一次启动后不追加提示、不调整环境、不自动重试。

## 运行配置

| 套件 | target | harness profile | backend |
| --- | --- | --- | --- |
| neural-network-video-flash-full | cc-ds-flash-video | claude-code-video | 官方 deepseek / deepseek-flash |
| neural-network-video-opus-full | cc-opus-5-5-video | claude-code-video | anthropic / claude-opus-5-5 |
| neural-network-video-cursor-full | cursor-opus-5-5-high-video | cursor-agent-video | Cursor 原生登录 / claude-opus-5-5-high |

三个套件均显式 repeat=1、concurrency=1、timeoutMs=3600000。CLI `--timeout-ms` 仍按原有规则覆盖，只改变本轮快照。Opus API 使用 provider 明确配置的地址，不自动读取设备 Claude 配置或切到历史中转接口；Cursor 原生模型名不是底层版本证明。

```bash
npx tsx src/cli.ts bench run --suite neural-network-video-flash-full --dry-run
# 确认配置后正式运行（会产生 API/账号用量）
npx tsx src/cli.ts bench run --suite neural-network-video-flash-full
```

新增 profile 的可选 `execution`：

```json
{
  "fullAccess": true,
  "proxy": "claude-shell",
  "maxOutputBytes": 134217728,
  "pinModelAliases": true
}
```

- `fullAccess` 仅支持可写 Claude Code API 和 Cursor。Claude 使用 bypassPermissions、默认工具、关闭原生 sandbox；Cursor 使用 `--force` 与 disabled sandbox，允许文件/命令/网络工具，MCP 仍禁止。完整权限可访问工作区以外文件，不宣称沙箱隔离。Claude 订阅继续使用原有认证与隔离约束，不接受这套 API 扩展。
- `proxy=inherit` 显式继承八个标准 HTTP/HTTPS/ALL/NO_PROXY 大小写环境变量；`claude-shell` 另外将它们安全引用写入本轮私有 CLAUDE_ENV_FILE，供 Claude 的工具 shell 使用。配置只存策略，不存代理凭据；实际进程计划脱敏记录。系统环境仍决定当次代理地址。
- `maxOutputBytes` 为主执行进程 stdout+stderr 总上限，1024–134217728 字节。视频设 128 MiB；未配置仍为 16 MiB。到达上限终止进程并记失败，不静默丢日志。它不是 token 预算，版本/认证探针保持原有限制。
- `pinModelAliases=true` 将 Claude 的 Opus/Sonnet/Haiku 与 small-fast 默认别名统一到 target 明确指定的模型；不依赖 provider 品牌。
- Cursor 视频 profile 保留原生用户 HOME/PATH 与 /bin/bash；配置/data 仍按轮独立。与普通 profile 的工具 shell 隔离不同，可能读取本机上下文；不能声称跨 harness 环境完全相同。

普通只读/可写 profile、旧视频套件都不变。执行计划在 dry-run 和实际执行之前通过同一配置函数生成，快照保留策略，record.raw.plan 保留脱敏后的实际 argv/env/文件内容。

## 评审附件

先从已保存记录创建模板，不调用模型、不加载 .env：

```bash
npx tsx src/cli.ts bench review-template b_0123456789 --output data/tmp/video-review.json
```

模板覆盖该实验已有样本，每项绑定 `benchmarkId/target/sample`、原始 `recordSha256` 与 `specSha256`。填写：

- `reviewer`、`reviewedAt`、`method`（human 或 agent-assisted）。如只是导入以前的抽帧结果，注明来源与检查范围，不能声称已听完整旁白。
- `verdict`：unreviewed / accepted / needs-work / rejected。无整体判断保留 unreviewed；未评审不能填评分。
- `notes`、`evidence`：结论和证据路径/URL，可把成片 SHA-256 写入 notes。证据只引用，不执行或自动读取，不假称校验了证据文件。已评审或有核对用量时必须填写人名、日期和证据。
- `scores`：可选 `{dimension,score,max}` 数组。建议分别评中文可读性、科普准确性、讲解组织、画面、音频；明确量表和抽查范围，未检查的维度不打分。分数不自动合成排名。
- `usageAlternatives`：可选的独立核对口径，格式见下文。不修改 record 原始值。

可以将多个模板的 entries 合入一个文件，重复样本会拒绝。报告只接受本次所选实验内的条目，指纹失配直接报错，不能拿另一次生成的评审冒充当前样本。模板和报告输出均拒绝覆盖已有文件。

```bash
npx tsx src/cli.ts bench report b_0123456789 --review data/tmp/video-review.json --output data/tmp/video-report.md
# 同样支持 --format json 或 csv
```

自动 grade 与评审分开：容器可读/竖屏通过不代表科普正确、画面美观；评审拒绝也不改历史 grade。未提供附件时输出格式保持原样。JSON 保留完整附件快照及附件 SHA-256；CSV 附加 reviewsJson / reviewedUsageJson。新执行配置另有 executionPolicyJson。

## 核对用量与费用重算

`usageAlternatives` 的每项示例（数字只是格式示例）：

```json
{
  "label": "per-model-total",
  "source": "原始 result.modelUsage.<模型>；与 result.usage 的差异未完全解释",
  "promptTokens": 1000,
  "completionTokens": 200,
  "totalTokens": 1200,
  "promptCacheHitTokens": 800
}
```

输入必须已经包含缓存读/写，输出必须已经包含推理。缓存命中数必须小于等于总输入；缺缓存字段表示未知，不能填零冒充已确认。来源名称和证据由评审者负责，工具只做结构、计数和记录指纹校验，不自动认定账单完整性。

沿用统一报告的显式价格快照：

```bash
npx tsx src/cli.ts bench report b_0123456789 --review data/tmp/video-review.json --pricing data/tmp/verified-prices.json --scenario offPeak --output data/tmp/video-cost-report.md
```

价格文件保持现有 `{currency,verifiedAt,sources,models:[{provider,model,scenarios}]}` 格式，由用户核对维护，provider/model 精确匹配，不猜峰谷或假日。主表仍按原始 usage 重算；附件各口径单独列出估价，不叠加、不覆盖、不混入每成功交付费用。不同口径算出的数字不是实际账单的保证上下界。原生 total_cost_usd 仅是原生报价，不当成中转/官方账单。Cursor 完整用量未验证，附件禁止提供核对用量，原始事件仍仅供审计；Claude/Codex 订阅即使附件有数字，也不能套 API 单价。未知仍为未知。

旧记录无需迁移，旧 manual-review/*.json 不会被自动当成新格式。先生成绑定旧记录的模板，再明确导入已有事实与证据；不得虚构原先没有的人工评分。
