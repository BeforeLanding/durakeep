# 01 调研与技术选型（修订版）

- 版本：v1.1，2026-11-06（Asia/Shanghai）
- 基础：2026-11-06 的基础调研，原文见 [research/baseline-2026-11-06](research/baseline-2026-11-06/README.md)（下称“原调研”，保持原样作为证据快照）
- 本版做了什么：逐条核对原调研引用的 1.5.0 API；补查 pi-ai 1.5.0、chord 1.5.0 发布包与规范的若干章节；在本机做了不花钱的环境验证；结合用户 2026-11-06 的四项决定收敛选型。**未安装依赖运行 agent，未调用任何付费模型。**

## 1. 结论

**采用 `@earendil-works/pi-durable@1.5.0` 作为对话与工具执行的持久化内核，包在 RuntimePort 适配层之后。** 原调研的总判断成立；本版在三个地方改变了设计：

1. **存储从“两个数据库”改为“一个 SQLite 文件、两套表前缀”**（Pi 用 `pi_`，业务用 `app_`），共享 chord 的 Node 适配器队列。这样可以在线做一致性备份，也只有一个文件归属需要保护。这一点依赖 P0 验证，失败时回退到原调研的双文件方案。见 [ADR-02](DECISIONS.md#adr-02)。
2. **提醒与后台作业的状态机放在业务库，由宿主调度器驱动**，不再给每条提醒建一个 Pi `sleepUntil` 任务。原因是提醒的修改、取消和 revision 校验必须和业务数据在同一个事务里，而 Pi 任务和业务表之间没有共享事务。Pi 专注它不可替代的部分：对话 run、工具调用的崩溃恢复、输入去重、steer/follow-up、上下文压缩和状态观察。见 [ADR-03](DECISIONS.md#adr-03)。
3. **按问题检索出的知识和记忆通过工具结果进入 transcript，不通过 system section 或 `beforeRequest` 注入。** 规范要求 section 渲染必须是确定的；渲染文本一变就会追加 system delta，并让 provider 的 prompt cache 失效。只有很少变化的“已确认全局偏好”才放进 section。见 [ADR-05](DECISIONS.md#adr-05)。

用户已确认的四项前提（2026-11-06）：

| 事项 | 决定 |
|---|---|
| 定位 | 自用 + 公开作品，仓库 `BeforeLanding/durakeep`；架构决策集中记录在 DECISIONS |
| 模型 | 默认 DeepSeek（pi-ai 内置 provider），允许把个人资料原文发给它 |
| 语义检索 | 先做词法检索（FTS5 + 中文分词），个人评测 Recall@10 未达 90% 时再接 embedding |
| 入口 | MVP 只做 Web，外部渠道放到 P3 |

## 2. 项目是什么（沿用原调研，已核对）

- 官方仓库 `earendil-works/pi`，包 `@earendil-works/pi-durable`。它是可以嵌入应用的 agent harness，不是个人助理产品，也不是 Pi coding agent CLI 本身。
- npm latest 为 1.5.0，发布于 2026-11-02，`engines.node >=22.19.0`，MIT 许可，标记为 Experimental。1.5.0 对工具 schema、存储协议和观察接口做了破坏性修改。
- 1.5.0 发布包的依赖**全部精确锁定在 1.5.0**：`@earendil-works/chord`、`pi-ai`、`pi-codemode`、`pi-schema`、`pi-telemetry` 均为 `1.5.0`，另有 `@silvia-odwyer/photon 0.3.3` 和 `diff 8.0.4`。本项目照此锁定，不用 `^`。
- 原调研的双基线做法保留：功能判断以发布包为准；主分支提交 `2a32a60` 只用于定位源码和规范。主分支 Unreleased 的 `Tx.submission(id)` 不作为实现前提。

## 3. 核对结果：原调研引用的 API

下列调用都已在 1.5.0 发布包 README 或规范的类型定义中找到，原调研的说法成立：

| API | 用途 | 出处 |
|---|---|---|
| `Harness.open(storage, { models, registry, settings, onReport, now, setTimer }, ctx)` | 打开会话存储 | README Quick Start / Sleeping |
| `openNodeSqliteStorage(path, { prefix })` | Node SQLite 存储，可加表前缀 | README Storage；源码 `storage/sqlite/node.ts` |
| `harness.root()` / `createConversation()` / `harness.resume()` | 会话与恢复 | README Persist and Resume |
| `conversation.submit({ type, content, requestId, whenBusy, entry })` | 接纳输入，同一会话内用 requestId 去重 | README Busy Conversations |
| `submission.wait()` / `harness.submission(id)` | 等待结果；重启后按 ID 重新获取 | README |
| `conversation.watch()` / `ConversationTranscript` | UI 订阅与断线重连 | README Watching |
| `defineTool({ replay: "safe" })` | 崩溃后重跑，否则结果为 interrupted | README Tools |
| `settings.restartLimit`（默认 5）/ `settings.retry` / `settings.afterFailedRun` | 崩溃循环上限与失败后的排队策略 | README Failures and Recovery |
| `harness.closed` / `onReport` | 存储失败后宿主重开 | README Errors |
| `pi.usage` / `harness.usage()` | 用量 | README Usage and Cost |

## 4. 本版新增的已核实事实

### 4.1 模型接入：DeepSeek 已内置

`@earendil-works/pi-ai@1.5.0` 的发布包含有 `providers/deepseek`，导出 `deepseekProvider()`，协议为 `openai-completions`，读取环境变量 `DEEPSEEK_API_KEY`。模型目录包含两个模型：

| modelId | 名称 | 上下文 | 最大输出 | 目录价（USD / 百万 tokens：输入、输出、缓存读） | thinking 级别 |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek V4.1 Flash | 1,000,000 | 384,000 | 0.30 / 1.20 / 0.006 | low、high、max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 | 1.32 / 3.96 / 0.044 | high、max |

价格是 pi-ai 内置目录里的值，**还没有和 DeepSeek 官方价目页核对**，只用于预算估算。下单或公开成本数字前要重新核实。

pi-ai 1.5.0 **没有 embedding 接口**。语义检索如果以后需要，得另外接供应商或本地模型（见 ADR-06）。

### 4.2 测试替身：faux provider 与假时钟

- `@earendil-works/pi-ai/providers/faux` 提供 `fauxProvider()`、`fauxAssistantMessage()`、`fauxText()`、`fauxToolCall()`，可以按脚本返回模型回复和工具调用。官方示例 `13-chat.ts` 就是这么用的。**所有自动化测试都使用 faux，不产生费用。**
- `Harness.open` 支持注入 `now` 与 `setTimer`，用来在假时钟上运行，适合提醒和重试退避的测试。规范要求：打开同一份存储的所有进程必须使用同一个时钟。

### 4.3 共享 SQLite 文件

- `openNodeSqliteStorage` 内部先调用 chord 的 `openNodeSqliteDatabase` 打开数据库，再用 `SqliteStorage.open(database, { prefix })` 建立 Pi 存储。
- chord 1.5.0 的 `NodeSqliteDatabase` 基于 `node:sqlite` 的 `DatabaseSync`，公开 `exec`、`run`、`runCounted`、`get`、`all`、`transaction` 和 `close`。不相关的操作和事务会**在同一个队列里串行执行**。构造函数是公开的，可以先自己创建 `DatabaseSync` 再包装。
- README 写明：与宿主表共用数据库时，Pi 和宿主的所有查询都应走同一个适配器；绕过队列直接调用数据库，可能会被 Pi 事务一起回滚。README 只给了 Cloudflare 的例子，Node 下的同等用法属于推断，**需要 P0 验证**（任务 T-02）。
- 这样做不会带来跨 Pi commit 与业务事务的原子性，两者仍是独立事务。业务一致性仍然依赖幂等记录和恢复扫描（ADR-04）。

### 4.4 其他与设计直接相关的语义

- **轮次上限是原生功能。** `conversation.configure({ maxTurns })` 限制一次 run 的工具轮数，到达上限时以 `unanswered/turn_limit` 结束。原调研设想的“应用自建 8 轮上限”改用这个原生配置。
- **section 必须是确定的。** 渲染文本只要变化，就会追加 `pi.system` 条目并让 prompt cache 失效。所以当前时间不能放进 section，只能随每条输入一起提供（ADR-10）。
- **自定义输入条目。** `submit({ type: "input", content, entry: { kind: "app.user", data } })` 让模型看到 `content`，而界面按自己的 kind 渲染。可以在 `content` 前加上时间信封，同时界面只显示原话。kind 不能以 `pi.` 开头。
- **工具执行 API 提供 `taskId`、`callId`、`memo()`、`commit()`、`snapshot()`、`createTask()`。** `memo` 是任务内的持久记忆点，可以用来先记下 operation key 再执行外部动作。
- **`afterRun` 会在 `Submission.wait()` 返回之后才完成**，此时会话仍然忙。原调研的提醒成立：MVP 不使用 `afterRun`，后台整理走业务作业队列。
- **watch 窗口。** 默认保留最新 50 条，超过 100 条时裁剪；重连时用 `transcript.resume` 只补缺失部分。服务端可以直接使用 `ConversationTranscript`。
- **写入条目。** 只含 `kind` 和 `data` 的 write 会立即追加，不影响模型看到的内容，可用于在会话里记录“提醒已触发”这类事件。

### 4.5 本机环境验证（2026-11-06，不涉及付费）

| 项目 | 结果 |
|---|---|
| Node 版本 | v24.16.0，满足 ≥22.19.0 |
| `node:sqlite` 内置 SQLite | 3.53.0 |
| FTS5 `unicode61` 与 `trigram` 分词器 | 都能创建 |
| `DatabaseSync.loadExtension` | 存在（目前方案不需要扩展） |
| `Intl.Segmenter('zh', { granularity: 'word' })` | “间隔重复是一种高效的记忆方法，我希望每周回顾简短一点。”分为：间隔 / 重复 / 是 / 一种 / 高效 / 的 / 记忆 / 方法 / 我 / 希望 / 每周 / 回顾 / 简短 / 一点 |
| pi-ai、chord 1.5.0 tarball | SHA-512 与 registry integrity 一致 |

结论：中文分词可以不依赖 jieba 等原生模块，先用 ICU 内置分词，再交给 FTS5 `unicode61` 处理已分好词的文本。两字词搜索因此可行，弥补了 trigram 无法处理少于 3 个字符查询的限制。分词质量仍需要用个人资料评测确认（ADR-06）。

## 5. 必须明确的边界（沿用原调研，未变）

- **持久化边界。** SQLite 采用 WAL + `synchronous=NORMAL`：进程崩溃时已提交的数据不会丢，断电或宿主故障时最新的提交可能丢失。流式中间输出最迟约 1,000 ms 才落盘。不能宣传“零丢失”。
- **所有权边界。** 同一份 storage 只能被一个进程拥有，框架不提供跨进程锁，需要应用自己实现实例锁。
- **外部事务边界。** Pi commit 与外部 API 之间没有原子性。MVP 没有外部副作用（站内通知除外），P3 接入外部渠道时才需要处理 unknown 状态的核对。
- **安全边界。** 默认权限继承启动进程的权限。MVP 不安装 `CodingTools`（read/write/edit/bash），也不提供任意网络访问工具。

## 6. 方案对比（压缩自原调研）

| 路线 | 适用 | 本项目取舍 |
|---|---|---|
| pi-durable 单进程 + SQLite（选用） | 单人、持续对话、需要崩溃恢复 | 实验性 API，用适配层隔离；版本锁死 |
| Cloudflare Durable Objects + PiHarness | 需要随时公网可达 | 平台约束和费用更多；作为部署备选，不在 MVP |
| LangGraph | 显式图流程、复杂审批 | 前期图建模成本高，本项目的流程是单会话循环 |
| Temporal | 复杂跨系统工作流 | 多一套基础设施，规模不需要 |
| 直接 RAG + 单次模型调用 | 一次性问答 | 没有持久任务和恢复，满足不了“事情不会悄悄丢” |

## 7. 采用与退出条件

- **采用门槛（G0）：** P0 的恢复、去重、共享文件和备份用例全部通过（见 [08 测试计划](08-test-plan.md)）。
- **退出条件：** 锁定版本后仍无法稳定通过故障用例，或关键路径必须依赖未发布的补丁。退出时保留业务数据和工具接口，只替换 RuntimePort 的实现。
- **降低退出成本：** Pi 类型只出现在 `packages/runtime-pi`；业务模块不读写 `pi_` 表；知识、记忆和提醒都使用应用自己的数据格式。

## 8. 相对原调研的修订清单

| # | 原调研 | 本版 | 依据 |
|---|---|---|---|
| 1 | Pi 库和业务库是两个文件，备份时停服 | 一个文件、两套前缀，用 `VACUUM INTO` 在线一致备份；P0 验证失败则回退 | chord `NodeSqliteDatabase` 串行队列；README Storage |
| 2 | 每条提醒建一个 `sleepUntil` durable task | 业务库 `app_schedules` + 宿主调度器；提醒触发后用 write 条目记入会话 | 避免跨存储双写；提醒必须与修改、取消同事务 |
| 3 | 记忆“每次注入约 1,000 tokens”，注入方式未定 | 已确认的全局偏好放进确定性 section（≤300 tokens）；按问题检索走工具 | 规范 §7.4：section 必须确定 |
| 4 | 应用自建 8 轮工具上限 | 原生 `maxTurns: 8` | README Per-Conversation Agent |
| 5 | 中文分词器“待评估”，不指定 | `Intl.Segmenter` + FTS5 `unicode61`，trigram 补充 ≥3 字符的子串 | 本机实测 |
| 6 | 模型供应商未选 | DeepSeek，`deepseek-flash` 为默认 | 用户决定；pi-ai 内置 |
| 7 | 语义检索属于 MVP 必须交付 | 改为由评测决定，保留 Embedder 接口 | 用户决定；pi-ai 无 embedding |
| 8 | 预算只给演算方法 | 按目录价给出示例数额（未核实官方价） | §4.1 |
| 9 | “摘要”属于 P1 | 移到 P2，P1 专注采集、检索和引用 | 范围纪律 |
| 10 | 测试替身未展开 | faux provider + 假时钟 + 子进程故障注入，付费评测每次单独确认 | §4.2；用户的付费评测规则 |

## 9. 仍未验证的事项

都已列入 P0 或 P1 任务，验证之前不写成事实：

1. Node 下 Pi 存储与宿主表共用一个 `NodeSqliteDatabase`，长期运行是否稳定；`VACUUM INTO` 的副本能否被 Pi 重新打开并恢复任务（T-02、T-05）。
2. 工具内能否通过 `api.snapshot` 读到当前 run 的锚点条目（`pi.live.run.first`），用来生成 operation key（T-04）。
3. section 的 render 函数能否是异步的、能否读取宿主数据库（T-03）。
4. 带 `requestId` 的 `type: "write"` 提交是否同样去重（T-03）。
5. DeepSeek 真实调用下的工具调用格式和中文引用遵从度（P1 付费评测，需用户逐次批准）。
6. HTML 正文抽取库（`@mozilla/readability` + `linkedom`）对中文页面的效果（T-13）。
