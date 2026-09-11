# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。每个 PR 在 Unreleased 下加一行；完成一个里程碑时升版本、打 tag、发 Release。

## [Unreleased]

### Added

- `appendTurn` / `run` / `compare` 可注入 completer；新增 `tests/fake-completer.ts`，编排逻辑可离线测试（#1）。
- GitHub 工程骨架：CI（typecheck + test + 离线冒烟，Node 20 / 22）、issue 与 PR 模板、`master` 分支保护、四个里程碑与 14 个带验收标准的 issue。

## [0.1.0] - 2026-09-11

### Added

- 初始化：OpenAI 兼容对话、会话树与分支、多配置对比落盘。
- 多 provider；DeepSeek V4 的 `thinking` 与 `reasoningEffort`。
- `AGENTS.md`；`data/tmp/` 一次性输入目录。
