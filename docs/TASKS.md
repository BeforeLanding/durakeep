# 任务看板

卡片内容（产出、DoD、依赖）见 [09 实施计划](09-implementation-plan.md#2-任务卡片)，此处只记状态。状态：`todo` / `doing` / `review` / `done` / `blocked`。

| 阶段 | 任务 | 状态 | 备注 |
|---|---|---|---|
P0 | T-00 仓库骨架 | done | |
P0 | T-01 Pi 最小链路与故障注入框架 | done | |
| P0 | T-02 共享数据库验证（ADR-02） | done | K1、K2 通过 |
| P0 | T-03 section 与 write 语义验证（ADR-05） | done | K5 通过、K6 去重 |
| P0 | T-04 写工具幂等（ADR-04） | done | K4、R2×20 通过 |
| P0 | T-05 实例锁、存储失败与备份 | done | R8、R15、R16、K3 各 ×20 通过 |
| P0 | T-06 RuntimePort 与 P0 报告 | done | G0 通过，见 spikes/P0-REPORT.md；出口 G0 |
| P1 | T-10 认证与 HTTP 骨架 | done | S1–S4 通过 | |
| P1 | T-11 会话与入口 | done | R1、R9、R10、FR-CHAT-03/04/05 通过 | |
| P1 | T-12 SSE 与快照转换 | done | 断线重连只补发缺失条目 | |
| P1 | T-13 采集 | done | S6–S9、S12、R13 通过；10 页质量检查见 spikes/T13-extraction-check.md |
| P1 | T-14 分块、分词、FTS | done | 不变式 2 有测试；1 万片段 p95 约 84–114 ms |
| P1 | T-15 检索与知识工具 | done | 采集→检索→回答跑通；写工具 R2 ×20 通过 |
| P1 | T-16 引用解析与校验 | done | |
| P1 | T-17 检索评测集与脚本 | done | Recall@10 96.7%；9 篇语料、缺版本类题，见 PROGRESS |
| P1 | T-18 Web 前端 | done | 录屏未做，见 PROGRESS |
| P1 | T-19 导出与回答评测 | done | G1 通过；人工抽查 20 题只做了 5 题，用户决定不再抽（见 PROGRESS） |
| P2 | T-20 记忆存储与工具 | done | FR-MEM-01/02/03 集成测试通过；缺 R2 ×20 |
| P2 | T-21 profile section | done | K5 在真实记忆上复测通过 |
| P2 | T-22 提醒与调度器 | done | R4、FR-REM-01–04、夏令时拒绝、p95 延迟通过；用 Intl 未用 luxon |
| P2 | T-23 后台会话与摘要 | done | R14 ×20 通过；前端暂未展示 / 编辑摘要 |
| P2 | T-24 候选记忆提取 | done | R5、敏感样例通过；前端候选标签沿用 T-26，未手动走通 |
| P2 | T-25 删除语义 | done | FR-KB-08 通过；记忆删除 + suppression 在 T-20 已有；旧会话无引用记录 |
| P2 | T-26 前端：记忆、提醒、通知 | done | 手动走通创建→到点→徽标→通知；候选标签已有生产者（T-24） |
| P3 | T-30 备份恢复演练 | done | R12 ×20 通过，耗时见 PROGRESS |
| P3 | T-31 预算与用量 | todo | |
| P3 | T-32 健康页与升级手册 | todo | |
| P3 | T-33 演示模式 | todo | |
| P3 | T-34 公开发布材料 | todo | 推送前需用户同意 |
| P3 | T-35 外部通知渠道 | 可选 | |
