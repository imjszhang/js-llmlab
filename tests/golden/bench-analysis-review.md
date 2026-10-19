# Benchmark 离线分析

输入：b_0123456789；去重后 1 个子实验。

通过率分母包含全部计划样本；未落盘样本单独标为缺失。耗时含失败与超时，成功耗时只含执行完成且验收通过的样本。

## 逐任务结果

| 轮次 | 任务 / target | provider / 模型 | 通过 / 计划 | 执行：完成/失败/超时/缺失 | 验收：失败/错误/未运行/缺失 | 全部耗时 s 均值 (范围) | 成功耗时 s 均值 (范围) | 用量覆盖 |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: |
| b_0123456789 / b_0123456789 | demo / agent | test / model-a | 1/1 | 1/0/0/0 | 0/0/0/0 | 1.00 (1.00–1.00) | 1.00 (1.00–1.00) | 1/1 |

## 条件与快照

| 实验 / target | Harness / 版本 | 预算 ms | repeat / 并发 / targets | 任务 SHA-256 | fixture SHA-256 | target SHA-256 |
| --- | --- | ---: | --- | --- | --- | --- |
| b_0123456789 / agent | claude-code / claude-test 1.0 | 5000 | 1 / 2 / 1 | 1d3d419accf48dc5a144980d686a5e7c29c53600dfd784ef37d18fc47f8df865 | frozen-fixture | f12f8b1e19c73139a73b93ef8d5793af14dd2045240af62935837cfe34f0fa75 |

## 费用估算

价格核对日期：2026-10-18；价格文件 SHA-256：119403477580ca82f659757d421c1d499628af1d4715c0132153e639a4d763a5。

- [Maintained rate sheet](https://example.test/pricing)

按明确 provider + model 匹配价格；情景由用户选择，不自动判断峰谷。输出已含推理 token，不重复相加。缓存命中未知时提供上下界；缺用量不按零计算。费用包含失败尝试；每成功交付费用仅在全部尝试可估价且至少一次通过时计算。

| 实验 / target | 情景 / 币种 | 估价覆盖 | 已知费用下限 | 总费用 | 每次尝试 | 每成功交付 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| b_0123456789 / agent | offPeak / CNY | 1/1 | 0.000256 | 0.000256 | 0.000256 | 0.000256 |
| b_0123456789 / agent | peak / CNY | 1/1 | 0.000512 | 0.000512 | 0.000512 | 0.000512 |

## 原生费用记录（未用于 API 估算）

Harness 原生费用可能使用其他模型定价；不同来源、币种分别保留，不视为 provider 账单。

| 实验 / target | 来源 / 币种 | 有值样本 | 已知金额 |
| --- | --- | ---: | ---: |
| b_0123456789 / agent | harness-reported / USD | 1/1 | 55.000000 |

## 人工评审与用量核对

附件 SHA-256：e119cdb02fe2ecd94f5bf5651852baecdc6f953e9e9a506b36fbef4e1f2462a7。评审不改变自动验收；核对用量单独估算，不覆盖原始用量或混入汇总费用。证据路径仅作引用，不执行或自动读取。

### b_0123456789 / agent / 1

评审：needs-work；reviewer / agent-assisted / 2026-10-19。

Frames inspected; audio not checked

- readability：3/5
- 证据：manual-review/contact-sheet.jpg

核对口径 native-modelUsage（result.modelUsage.model-a）：输入 200，输出 40，缓存命中 160。

- offPeak / CNY：0.000512（exact）
- peak / CNY：0.001024（exact）
