# pi-durable 调研与技术选型

## 选型结论

对于知识管理与日常助理，pi-durable 值得作为执行内核试用，主要收益在于会话与任务持续运行。采用条件是：接受实验性 API；愿意维护少量适配层；把长期记忆和外部效果一致性当作产品功能实现；在接入真实数据前验证重启、重试、取消和备份恢复。

若需求仅是一次性文档问答，直接的检索加模型调用更简单。若目标是多团队审批、复杂跨系统业务流程，则应重新评估图式工作流或专门的持久工作流基础设施。该比较是结合本项目范围的工程判断，未做框架性能排名。

## 项目是什么

官方项目位于 `earendil-works/pi`，npm 包为 `@earendil-works/pi-durable`。Pi coding agent 是交互式编程产品；pi-durable 是可嵌入应用的 agent harness，负责组织模型调用、工具执行、会话记录和任务状态。它基于 pi-ai 接入模型，基于 Chord 管理文档状态。不能假设 Pi CLI 的所有扩展、登录方式、界面和配置能直接复用。[官方介绍](https://earendil.com/posts/pi-durable/) · [仓库说明](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/README.md)

本次采用双重基线：发布包 1.5.0 用来判断可依赖的功能；主分支提交 `2a32a605a9f18a5f0191f65358a2e764b2f69fc7` 用来定位源码和规范。该提交时间为北京时间 2026-11-06 07:35:09，晚于发布包，二者不视为同一份构建。未使用主分支 Unreleased 的 `Tx.submission(id)` 作为实现前提。[npm 元数据](sources/npm-metadata.json) · [发布记录快照](sources/packages__durable__CHANGELOG.md)

## 与个人助理直接相关的能力

### 会话与输入

Harness 打开一份 storage；Conversation 保存对话；Submission 表示交给会话的输入或写入。`submit()` 接纳输入，`wait()` 等待 done 或 unanswered。`requestId` 在同一 conversation 内去重，适合客户端重发和 webhook 重投。应用仍须拒绝“同一请求 ID 携带不同内容”的冲突，不能把 requestId 当作权限凭据或跨会话全局去重机制。[README 的 Persist and Resume](sources/published-1.5.0/package/README.md) · [规范第 6 节](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/docs/spec.md)

忙碌时可以 follow-up、steer 或 reject。steer 在当前工具轮次之后介入，并不意味着已开始的外部操作可以撤销。适合“接着整理这篇文章”和“后面的摘要请用中文”等交互。取消等待只取消客户端等待，不等于停止服务端工作。[发布包 README 的 Busy Conversations](sources/published-1.5.0/package/README.md)

### 任务恢复与工具

任务以状态机阶段和检查点持久化。工具调用先记录意图；如果进程在执行中退出，只有声明 `replay: "safe"` 的工具才会自动重跑，默认 unsafe 的工具会得到 interrupted 结果。safe 表示开发者承担重放安全责任，不是框架自动证明没有副作用。[发布包 README 的 Tools](sources/published-1.5.0/package/README.md)

崩溃恢复不是无限重试：发布包包含 restartLimit 与模型重试配置；缺失扩展、迁移失败、轮次耗尽、模型错误和存储错误都有失败路径。宿主要展示失败并决定恢复策略。仅靠进程管理器反复拉起不能保证任务最终完成。[发布包 README 的 Failures and Recovery 与 Errors](sources/published-1.5.0/package/README.md)

### 长对话与长期状态

Compaction 摘要旧上下文，旧 transcript 仍存储在后端。Document 允许把应用 JSON 状态与会话变更一起提交。这些构件可以承载记忆的引用与工作状态，但语义记忆提取、事实核对、用户修改和检索不是自动完成的。原始资料、来源定位、用户偏好和待办不应只存在于一份压缩摘要中。[发布包 README 的 Compaction 与 Your Own State](sources/published-1.5.0/package/README.md)

### 持久化休眠与提醒

`runtime.sleepUntil()` 把截止时间和下一个阶段存储下来；进程重启后，调度器可以继续到期任务。常驻 Node 服务需要进程监督；会被回收的宿主需要通过 onWake 和平台 alarm 唤醒。周期规则、时区、漏发补偿、通知渠道及去重都由应用实现。[发布包 README 的 Sleeping and Waking Up](sources/published-1.5.0/package/README.md)

### 客户端同步与成本

可观察会话状态和任务图，适合刷新页面后恢复界面。1.5.0 已移除旧的 watchEvents 路线，应从当前 watch 与 transcript API 设计适配层。`pi.usage` 提供用量记录，但极早崩溃的流式调用可能未留下用量，不能替代供应商账单。[1.5.0 发布记录](sources/published-1.5.0/package/CHANGELOG.md)

## 必须明确的边界

**持久化边界。** 正式记录与可延迟保存的流式进度不同；默认进度保存窗口约 1,000 ms。SQLite 默认 NORMAL 模式可能在断电或宿主故障时丢失最近提交。若用户要求更强保证，应验证相应 SQLite 配置、磁盘语义和备份，不把“可恢复”写成“零丢失”。[发布包 README 的 Watching a Conversation 与 Storage](sources/published-1.5.0/package/README.md)

**所有权边界。** 同一 storage 只能有一个拥有者进程，框架不提供跨进程锁。多个 HTTP 请求可以进入同一服务；多个 worker 进程同时打开同一库不是可接受的扩容方式。只读观察路径也不能运行任务。[发布包 README 的 Storage](sources/published-1.5.0/package/README.md)

**外部事务边界。** 框架提交与邮件发送、外部日历写入不存在天然原子事务。外部请求成功但本地结果尚未保存时崩溃，恢复后必须使用同一个业务操作 ID 查询或幂等重试；无法查询时进入待核对状态。[规范第 5.2 节 Effect sandwich](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/docs/spec.md)

**安全边界。** 扩展与执行环境能组织工具，但不等于操作系统级隔离。Pi 仓库明确说明默认权限继承启动进程。给个人知识助理装上 unrestricted bash、任意文件读取或任意网络请求，会扩大资料与凭据暴露面。[仓库权限说明](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/README.md#permissions--containerization)

## 部署与参考项目

### 推荐路线 单进程 Node 与 SQLite

适合单人和小规模资料：开发链路短，原始文件容易保留，故障注入容易执行，数据导出简单。代价是自己负责常驻进程、磁盘、备份、访问认证和升级。SQLite 用于长期运行；Memory 仅做测试；JSONL 会把完整历史保留在内存，不能因为文件易读就作为长期默认后端。[发布包存储说明](sources/published-1.5.0/package/README.md)

### 备选路线 Cloudflare Durable Objects

适合希望 Web 随时可访问、接受云托管和平台约束的场景。Cloudflare 官方已提供 PiHarness 生命周期集成，文档说明 Agents SDK 0.33.0 及以后支持 Pi 1.5，并提醒跨 Pi minor 的存储回滚兼容问题。实施时锁定具体配套版本，不混用新旧教程。[Cloudflare Pi 集成](https://developers.cloudflare.com/agents/harnesses/pi/)

Earendil 的 pi-durable-cloudflare 示例具有多会话、重连、定时 follow-up、历史搜索和任务活动界面，适合作为设计参考。README 明确表示缺少认证与限流，因此不能直接公开部署成个人服务。[官方示例](https://github.com/earendil-works/pi-durable-cloudflare)

### 渠道与生态参考

官方 pi-chat 是连接 Discord 与 Telegram 的 Pi 扩展，适合参考渠道和隔离方式；不能仅因同属 Pi 生态就认定它是本方案的 pi-durable 应用骨架。[pi-chat](https://github.com/earendil-works/pi-chat)

社区 pi-durable-telegram 更接近常驻个人机器人，可以参考输入队列、交付检查点和插件入口。本轮只审阅其文档，没有安全审计、运行或验证其插件兼容性。[项目 README](https://github.com/smixs/pi-durable-telegram)

## 其他技术路线为何暂不优先

LangGraph 提供线程检查点和跨线程 store，适合显式图流程及更强流程编排需求；对本项目而言，采用 pi-durable 可以围绕一个会话循环扩展工具，减少最初的图建模。该取舍取决于未来审批分支复杂度。[LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

Temporal 通过工作流历史与 replay 支持持久执行，更适合作为复杂跨系统流程的候选。本 MVP 先验证一个人的资料与提醒闭环，额外引入一套工作流基础设施是否值得，需要后续规模与运维需求证明。两者都不能免除外部效果的幂等设计。[Temporal Tasks](https://docs.temporal.io/tasks)

## 采用与退出条件

完成恢复、去重、来源问答、备份还原和升级演练后再正式使用。若固定版本仍无法稳定通过故障用例，或必须依赖未发布补丁才能完成关键路径，应暂停扩功能，保留业务数据和工具接口，替换运行内核。

为降低退出成本，知识与记忆数据使用应用自有格式；Pi 类型只在 runtime adapter 内出现；业务模块不直接读写框架内部 SQLite 表。无需在第一版实现第二套框架，只需保留清晰边界。
