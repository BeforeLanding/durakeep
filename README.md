# durakeep

一个基于 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 的单用户个人知识与日常助理：收藏资料、带引用问答、可编辑的长期记忆、一次性提醒。核心卖点是**持久执行**——已接纳的输入、执行中的工具、创建好的提醒，在进程崩溃重启后都不会悄悄丢失或重复生效。

> 状态：**P0 内核验证完成（2026-11-06，G0 通过）**，见 [P0-REPORT](docs/spikes/P0-REPORT.md)；仓库有骨架与验证代码，尚无产品功能。下一步是 P1，等待启动决定。

## 已确认的前提（2026-11-06）

| 事项 | 决定 |
|---|---|
| 定位 | 自用 + 公开作品；仓库 `BeforeLanding/durakeep` |
| 模型 | DeepSeek（pi-ai 内置），默认 `deepseek-flash`；允许资料原文发给模型 |
| 检索 | 先词法（Intl.Segmenter + SQLite FTS5），评测不达标再接 embedding |
| 入口 | MVP 只做本机 Web（127.0.0.1） |
| 技术栈 | Node ≥22.19（本机 24）· TypeScript（原生类型擦除）· pnpm · Hono · React + Vite · SQLite（node:sqlite）· vitest |

## 文档导航

| 文档 | 读者 / 用途 |
|---|---|
| [01 调研与选型（修订版）](docs/01-research.md) | 为什么是 pi-durable；本版相对基础调研改了什么；已核实与未核实的事实 |
| [02 产品需求](docs/02-prd.md) | 带编号的需求与验收条款、里程碑范围、非目标 |
| [03 系统架构](docs/03-architecture.md) | 模块、进程模型、关键流程、错误映射、安全、备份 |
| [04 数据模型](docs/04-data-model.md) | 完整 DDL、状态机、不变式、导出格式 |
| [05 pi-durable 接入规格](docs/05-runtime-integration.md) | 启动、设置、扩展与系统提示、工具目录、RuntimePort |
| [06 HTTP 接口](docs/06-api.md) | 全部端点、错误码、SSE、CLI |
| [07 知识库与长期记忆](docs/07-knowledge-memory.md) | 采集、分块、检索、引用校验、记忆、删除边界、评测集 |
| [08 测试与验收](docs/08-test-plan.md) | 故障注入、恢复用例 R1–R16、安全用例、验收矩阵、付费评测流程 |
| [09 实施计划](docs/09-implementation-plan.md) | P0–P3 任务卡、关键路径、风险、成本估算 |
| [DECISIONS](docs/DECISIONS.md) | 10 条架构决策 |
| [10 资料来源](docs/10-sources.md) | 证据分级与出处 |
| [AGENTS.md](AGENTS.md) | 给编码 agent 的硬规则与命令 |
| [TASKS](docs/TASKS.md) / [PROGRESS](docs/PROGRESS.md) | 任务状态看板 / 每张卡的完成记录 |

建议阅读顺序：本页 → 02 → DECISIONS → 03 → 05。准备动手时直接看 09 的 P0 任务卡和 08 §5。

## 持久性边界（会写进公开 README）

- 进程崩溃：已接纳的输入与已提交的业务写入不丢；未完成的回答按重试策略继续或明确失败。
- 断电 / 宿主故障：SQLite `synchronous=NORMAL`，最近的提交可能丢失。
- 流式输出：最多约 1 秒的已显示文字可能在崩溃后消失（最终结果不受影响）。
- 删除：资料“彻底删除”不能撤回已发送给模型供应商的内容，也不能从历史对话记录中物理抹除（见 07 §6）。

## 待定

- P3 是否接一个外部通知渠道。
- 长期运行的常开主机。

## 来源

基础调研（2026-11-06）的原文和资料快照保存在 [docs/research/baseline-2026-11-06](docs/research/baseline-2026-11-06/README.md)，保持原样；本版的修订清单见 [01 §8](docs/01-research.md#8-相对原调研的修订清单)。
