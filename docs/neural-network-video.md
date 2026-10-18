# 神经网络视频单次生成测试

日期：2026-10-18。任务 `neural-network-video`；套件
`neural-network-video-opus` 使用 Claude Code + Anthropic 官方
`claude-opus-5-5`，repeat=1、concurrency=1。只使用现有 API key 认证，
不导入个人 skills、MCP、记忆、其他项目代码或预制视频。

## 提示词与独立样式

原始提示保存在 `tasks/prompts/neural-network-video.original.md`。
实际输入为 `tasks/prompts/neural-network-video.md`，先把绝对路径
`@/Users/jszhang/github/my/js-designer-skill/references/aipoch-investor-deck`
替换为工作区内的 `@./style/aipoch-investor-deck`。按用户本次要求，再追加
“必须实际渲染并输出可播放的 MP4，不能只交 HTML 或源码。”；后续再追加
“必须保证中文字体正常、文字清晰可读，交付前检查实际渲染画面并自行修复问题。”。
字体查找、依赖安装与实际画面检查由 harness 自主完成，不预置具体字体路径或修复代码。原始提示
存档与既有实验的冻结输入保持不变。没有追加分镜、神经网络
解释、框架选择、视频时长、精确比例、配音或输出命名要求。

样式独立保存在 `tasks/fixtures/neural-network-video/style/aipoch-investor-deck/`。
源目录为用户指定的 `js-designer-skill/references/aipoch-investor-deck`，只读
提取该目录，没有沿原文档链接追读其他项目。保留配色、字体、明暗画布、
科学编辑插画语言和 4 张 reference-only PNG；插画规范与 PNG 按原字节复制。
README、design 与素材说明整理为独立版本，移除了上游目录依赖、logo、
融资叙事与页码要求。来源文件的 SHA-256 和适配方式记在 provenance.json。

竖屏来自用户原提示，优先于原横版演示文稿；自动检查只要求显示高大于宽，
不强加 9:16。参考图 license 为 not-published，只能观察视觉语言，不得直接
作为成片素材。fixture 只含样式输入，没有脚本骨架、分镜或参考答案；
`style/**` 的已有文件全部固定 hash，改写或删除会验收失败；新增作品文件允许。

## 单次的口径与运行

一次人类提示、一个独立样本；允许 harness 内部自主读素材、写代码、调用
工具、渲染和自检。它可能包含多次模型请求，不能称为一次 API 调用。
不追加人工修改提示，不自动补跑。单次运行预算为 60 分钟，包含版本检查
和执行，不是要求生成 60 分钟视频；可用 CLI 覆盖预算，但须单独记录比较。

```bash
npm start -- tasks validate neural-network-video
npm start -- bench run --suite neural-network-video-opus --dry-run
# 配好 Claude Code 和 ANTHROPIC_API_KEY 后，实际执行一次：
npm start -- bench run --suite neural-network-video-opus
```

dry-run 不发模型请求、不启动 Claude Code、不落实验记录。默认套件仍使用
上述官方 API target；使用设备已配置网关时，必须在本轮快照中另记真实
provider、地址及认证来源，不能据模型名声称走了官方接口。

正式运行前应固定环境，并随实验另存 Claude Code、Node/Python、浏览器、
ffmpeg/ffprobe 与字体版本及网络策略。现有执行层记录 harness 版本和冻结
任务、target、fixture；它不会自动盘点所有渲染工具。验收机器必须能从
PATH 调用 ffprobe。样式文件不会强制安装框架，渲染工具不添加到本项目
运行依赖。测试自主完成能力时，由 Claude Code 自行选择并安装依赖、生成
和渲染；启动前固定完整权限、设备代理及环境记录，启动后只观察，不追加
提示、不修改环境、不停止其安装子进程。未生成视频应按实际阻塞记录。

进程透传标准大小写代理变量；认证代理值在记录中脱敏。运行中新建的真实
`.venv` / `venv` 目录不计入作品差异和 manifest；原 fixture 中已有的同名
输入仍检查，普通符号链接和链接形式的虚拟环境目录仍拒绝。旧实验记录与
其中冻结的验收脚本不回写，修复仅用于新实验。

## 自动技术检查

可信脚本 `tasks/checks/neural-network-video.mjs` 加载时内嵌到冻结任务，
不从候选工作区读取验收代码，也不执行候选源码。递归查找非空源码与
MP4/MOV/WebM/M4V，用无 shell 的 ffprobe 检查实际容器、视频流、正时长和
竖屏显示方向，并尝试读取少量帧。任一视频满足条件即可；依赖目录、
样式参考目录和隐藏环境目录不算作品，候选符号链接拒绝。

验收预算 30 秒。缺 ffprobe 输出 INFRASTRUCTURE ERROR，现有记录格式仍
将非零退出记为 failed，需结合诊断与环境判断。技术通过只说明存在基础
可读视频和源码，不证明全部帧可解码、源码可复现、科学正确或风格优秀。
本题不内置参考成片，`tasks validate` 只完成结构检查；checker 行为由本地
假探测器的离线单测覆盖，避免把人为参考解带入候选输入。

## 人工评审（与自动 grade 分开记录）

看完整视频并检查源码；每项记 0–2 分及具体画面/时间点证据，总分 10 分。
不能仅靠文本关键词、文件名或模型自述判定通过，也不能把“爆款”当作
已验证的传播效果。

| 项目 | 0 分 | 1 分 | 2 分 |
| --- | --- | --- | --- |
| 科学解释 | 关键机制错误或未解释 | 基本正确但关系不清 | 准确解释层、权重、输入到输出及学习如何调参，例子不误导 |
| 中文易懂 | 缺中文或难以理解 | 中文可读，仍有明显术语/信息负担 | 面向普通观众，例子清楚，表达连贯 |
| 视觉与样式 | 明显偏离或不可读 | 部分符合，有拥挤/节奏问题 | 竖屏清晰，暖白/黑/黄色焦点、科学线稿和留白一致 |
| 叙事与动效 | 缺逻辑或妨碍理解 | 能跟随但衔接粗糙 | 开场有问题意识，动态表达机制，节奏帮助理解 |
| 全代码与复现 | 无对应实现或依赖现成视频 | 有源码但复现信息/环境不完整 | 主要画面由源码生成，渲染入口和依赖明确，可在记录环境复现 |

特别检查：不把人工神经网络等同真实人脑，不把一次前向推理当作训练，
不把类比当作生物事实。若含配音、字幕或声音，同步与听感纳入相应项目；
原提示未强制音轨，不单独因无配音判失败。

耗时与 token 使用统一 bench 记录；费用未知保留 null。CLI 报价与 provider
实际账单分开，后续成本比较使用显式价格文件，不在 target 猜测单价。
