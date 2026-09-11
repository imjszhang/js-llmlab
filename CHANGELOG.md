# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。每个 PR 在 Unreleased 下加一行；完成一个里程碑时升版本、打 tag、发 Release。

## [Unreleased]

### Added

- `compare` 各路并行执行，缺省并发 3，`--concurrency <n>` 可调；结果按输入顺序写入；终端每路开始 / 结束各一行并打总耗时。在线 8 路实测总耗时 = 最慢一路（#4）。

### Changed

- compare 的 `report.md` 改为：元信息 → `## 汇总` 表（配置 | 模型 | thinking | effort | 耗时(s) | 推理 tok | 成稿 tok | 总 tok | 错误）→ Input → 各路成稿；思维链不再进 report，改写到 `variants/<配置>/reasoning.md`；`output.md` 只留成稿；终端结束时打同一张表（#5）。

## [0.2.0] - 2026-09-11

M0 地基：网络层可注入、离线冒烟、fixture 与黄金文件。此后所有编排逻辑都能在 CI 里不带 key 验证。

### Added

- `appendTurn` / `run` / `compare` 可注入 completer；新增 `tests/fake-completer.ts`，编排逻辑可离线测试（#1）。
- `run` / `compare` 新增 `--dry-run`：打印配置快照、密钥状态、messages 与请求体 JSON，不发请求、不落盘；CI 冒烟改用它（#2）。
- 测试基础设施：脱敏 fixture `tests/fixtures/polish-8way`、`scripts/export-fixture.ts`（`npm run fixture:export`）、黄金文件比对 `tests/golden.ts`（`npm run test:update-golden`）；`LabStore.readComparison` 可读回对比；落盘 JSON 解析集中到 `src/lib/parse.ts`（#3）。
- GitHub 工程骨架：CI（typecheck + test + 离线冒烟，Node 20 / 22）、issue 与 PR 模板、`master` 分支保护、四个里程碑与 14 个带验收标准的 issue。
- `--version` 改为读 `package.json`，版本号只维护一处。

## [0.1.0] - 2026-09-11

### Added

- 初始化：OpenAI 兼容对话、会话树与分支、多配置对比落盘。
- 多 provider；DeepSeek V4 的 `thinking` 与 `reasoningEffort`。
- `AGENTS.md`；`data/tmp/` 一次性输入目录。
