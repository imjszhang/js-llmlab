# Benchmark b_0123456789

任务：demo  创建时间：2026-10-17T00:00:00.000Z

Fixture SHA-256：`fixture-test-hash`；每路 2 次；并发 2。

| target | 次数 | 类型 / provider | 模型 | 执行 | 验收 | 耗时 s | token | 成本 | 改动文件 |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: |
| direct | 1 | llm / test | model-a | completed | passed | 1.20 | 10 | 0.030000 CNY | 0 |
| agent | 1 | harness / test | model-b | completed | failed | 2.35 | 10 | 0.120000 USD | 1 |
| agent | 2 | harness / test | model-b | timeout | not-run | 5.00 | - | - | 0 |

执行完成只表示 adapter 收到成功终态；任务是否完成看验收列。缺失 token / 成本显示为 -。

## 输入

Reply OK, then write result.txt.

## 采样

### direct / 1

执行：completed；验收：passed；usage 来源：request；成本来源：configured-pricing。

- 通过 output-contains：输出包含指定文本

[成稿](variants/direct/run-1/output.md) · [完整记录](variants/direct/run-1/record.json) · [事件](variants/direct/run-1/events.jsonl) · [文件改动](variants/direct/run-1/changes.json)

### agent / 1

Harness：claude-code；版本：claude-test 1.0；路由：anthropic-messages；权限：workspace-write。

执行：completed；验收：failed；usage 来源：run-total；成本来源：harness-reported。

- 失败 file-exists：文件不存在

[成稿](variants/agent/run-1/output.md) · [完整记录](variants/agent/run-1/record.json) · [事件](variants/agent/run-1/events.jsonl) · [文件改动](variants/agent/run-1/changes.json)

### agent / 2

Harness：claude-code；版本：claude-test 1.0；路由：anthropic-messages；权限：workspace-write。

执行：timeout；验收：not-run；usage 来源：run-total；成本来源：未知。

错误：time \| out partial


[成稿](variants/agent/run-2/output.md) · [完整记录](variants/agent/run-2/record.json) · [事件](variants/agent/run-2/events.jsonl) · [文件改动](variants/agent/run-2/changes.json)

