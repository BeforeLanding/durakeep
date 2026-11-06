# 架构决策记录

本文件只收**架构级**决策，供评审使用。过程记录、评测失误和日常取舍写进 `PROGRESS.md` / `CHANGES.md`，不写在这里。每条都写明验证方式；状态为“待验证”的条目，在对应任务通过前不算定案。

| ADR | 决策 | 状态 |
|---|---|---|
| [01](#adr-01) | pi-durable 只作为执行内核，藏在 RuntimePort 之后 | 已定 |
| [02](#adr-02) | 一个 SQLite 文件，`pi_` / `app_` 两套前缀，共用一个连接队列 | 待验证（T-02、T-05） |
| [03](#adr-03) | 提醒和作业的状态机放在业务库，由宿主调度器驱动 | 已定 |
| [04](#adr-04) | 写工具用 operation key 实现幂等，声明 `replay: "safe"` | 待验证（T-04） |
| [05](#adr-05) | 检索结果通过工具进入 transcript；稳定偏好放在确定性 section | 待验证（T-03） |
| [06](#adr-06) | 先做词法检索（Intl.Segmenter + FTS5），embedding 由评测决定 | 已定 |
| [07](#adr-07) | 入口先在业务层做幂等，再交给 Pi 的 requestId | 已定 |
| [08](#adr-08) | 不给模型 shell、文件系统或任意网络访问能力 | 已定 |
| [09](#adr-09) | 时间放进每条输入的信封，不放进 system prompt | 已定 |
| [10](#adr-10) | 后台模型调用走专用会话，用 requestId 保证结果可以取回 | 待验证（T-23） |

---

<a id="adr-01"></a>

## ADR-01 pi-durable 只作为执行内核，藏在 RuntimePort 之后

**背景。** pi-durable 1.5.0 标记为 Experimental，1.5.0 本身就改过存储协议和观察接口。个人助理的数据（资料、记忆、提醒）寿命要比框架的某个版本长得多。

**决策。** 只有 `packages/runtime-pi` 可以 import `@earendil-works/*`。业务模块只依赖 `RuntimePort` 接口（定义见 [05 §7](05-runtime-integration.md#7-runtimeport)）。所有业务状态使用应用自己的表结构，不存放在 Pi Document 里。依赖精确锁定在 1.5.0。

**备选。** 业务直接使用 Pi Document 存放记忆和提醒：少一层，但会把业务数据锁死在实验性存储格式里，退出成本最高。

**后果。** 需要多写一层适配（预计 300–500 行），以及一份 Pi 与业务之间的状态映射。好处是更换内核时只需重写一个包。

**验证。** 依赖检查规则：`packages/*` 中除 `runtime-pi` 外，出现 `@earendil-works` import 即失败（T-00 写入 lint）。

<a id="adr-02"></a>

## ADR-02 一个 SQLite 文件，两套前缀，共用一个连接队列

**背景。** 原调研使用 Pi 库和业务库两个文件，备份时必须停服，否则两份快照的时间点不一致。chord 的 `NodeSqliteDatabase` 会把同一连接上的所有操作和事务排进一个队列，Pi 存储也支持表前缀。

**决策。** `data/app.sqlite` 一个文件：Pi 存储用 `SqliteStorage.open(db, { prefix: "pi_" })`，业务表统一使用 `app_` 前缀，二者共用同一个 `NodeSqliteDatabase` 实例。备份通过同一个队列执行 `VACUUM INTO`，得到的是 Pi 与业务处在同一时间点的快照。

**备选。** (a) 双文件 + 停服备份（原调研方案，作为回退）；(b) 双文件 + 分别做在线备份：两份快照时间点不同，恢复后会出现“Pi 认为工具已完成、业务库里却没有记录”的窗口，需要额外的对账逻辑。

**后果。** 业务查询与 Pi 提交串行执行；对单用户来说吞吐不是问题，但大批量写入（建索引）必须分批，每批控制在 50 ms 左右，避免卡住对话的提交。这样做**不会**带来跨 Pi commit 与业务事务的原子性，ADR-04 仍然必要。

**验证（T-02、T-05）。** ① Pi 在含有 `app_` 表的数据库里正常打开、提交、重开；② 业务事务与 Pi run 交错执行 1,000 次，没有死锁，也没有 `ReadAfterWrite` 错误；③ 运行中执行 `VACUUM INTO`，用得到的副本启动后，未完成的 run 能恢复。任何一项失败就回退到 (a)，并在此处记录原因。

<a id="adr-03"></a>

## ADR-03 提醒和作业的状态机放在业务库，由宿主调度器驱动

**背景。** Pi 的 `sleepUntil` 能在重启后继续等待。但提醒需要修改、取消和 revision 校验，这些操作必须与 `app_schedules` 在同一个事务里完成；而 Pi 任务的创建与业务行的写入分属两个事务，中间崩溃就会留下“有提醒没任务”或“有任务没提醒”。

**决策。** `app_schedules`、`app_jobs`、`app_outbox` 是唯一的事实来源。进程内的 `Scheduler` 用一个定时器指向最早的到期时间（每 60 s 再兜底检查一次）。到期后在**一个业务事务**里完成：写入 occurrence（唯一键为 `schedule_id + revision + fire_at`）、写入通知、推进 schedule 状态。之后再以 `type: "write"` 和 `requestId = occ:<id>` 把一条 `app.reminder_fired` 记录写进对应会话，供模型和界面看到。

**备选。** 每条提醒一个 Pi durable task（原调研方案）：更能展示框架能力，但会引入双写和对账；在单进程常驻的场景下，额外的持久化收益接近零。

**后果。** Pi 负责它不可替代的部分：对话 run、工具调用的崩溃恢复、steer/follow-up、压缩和观察。调度器和作业需要自己实现租约之外的部分，单进程不需要租约。时钟通过 `Clock` 接口注入，与 Harness 的 `now`/`setTimer` 共用同一个实现，测试时可以快进。

**验证。** T-22 的假时钟用例（R4）：睡眠期间修改或取消、到期前重启、关机补发后标记“迟到”。

<a id="adr-04"></a>

## ADR-04 写工具用 operation key 实现幂等，声明 `replay: "safe"`

**背景。** 工具在业务库提交之后、Pi 记下工具结果之前崩溃，就会出现窗口。如果工具声明为 unsafe，恢复时模型会收到 interrupted，并且很可能重新发起一次调用，产生新的 `callId`，所以按 `callId` 去重是不够的。

**决策。** 每个写工具计算
`op_key = sha256(conversation_id, run_anchor, tool_name, canonical_json(normalized_args))`，
其中 `run_anchor` 是当前 run 的第一个条目 ID。工具在**一个业务事务**里执行：查 `app_operations(op_key)`，已有记录就直接返回保存的结果，没有则执行写入并保存结果。工具声明 `replay: "safe"`。效果是：同一次 run 里同一个逻辑动作（重跑，或模型用相同参数再调一次）只生效一次；用户在新的 run 里再次要求，则作为新动作执行。

**备选。** (a) 按 `callId` 去重：挡不住模型重新发起的调用；(b) 让模型自己生成 operation_id：不可信，也无法保证稳定。

**后果。** 规范化函数必须稳定：去掉首尾空白，时间统一成 UTC instant，数组排序规则写死。同一次 run 里用户确实想做两次相同动作（例如“提醒我两次”）时会被合并；工具会把合并后的结果和 `deduplicated: true` 一起返回给模型，由模型如实告诉用户。

**验证（T-04）。** ① 工具内能读到 `run_anchor`；读不到时改用 `submission_id`，由入口写入一个 Pi Document，并在这里记录这一改动；② 在“业务已提交、Pi 结果未提交”的位置杀掉进程，重复 20 次，业务效果始终只出现一次。

<a id="adr-05"></a>

## ADR-05 检索结果通过工具进入 transcript；稳定偏好放在确定性 section

**背景。** 规范 §7.4 要求 section 渲染必须确定；文本一变就会追加 `pi.system` 条目并让 prompt cache 失效。`beforeRequest` 的修改只对单次请求生效，不会写进 transcript，事后无法审计“这次回答用了哪些记忆”。

**决策。** 
- 已确认的全局偏好（最多 20 条，约 300 tokens 以内）放进 `profile` section。按 `memory_set_revision` 渲染，只有记忆变化时文本才变。
- 知识片段与项目或主题相关的记忆，由模型调用 `kb_search`、`memory_search` 获取，结果作为工具结果写入 transcript，其中带有 `memory_id@revision` 和 `chunk_id`。

**备选。** 每次请求用 `beforeRequest` 自动检索并注入：召回更稳定，但无法审计，每次请求的前缀都不同，缓存全部失效。

**后果。** 回答质量依赖模型主动去检索。系统提示会要求“回答涉及个人资料或偏好之前先检索”。评测中会单独统计“该检索时没有检索”的比例，超过 10% 时考虑改成强制先检索一轮（入口直接提交一条 `kb_search` 结果）。

**验证（T-03）。** section 的 render 能否异步读取宿主数据；偏好不变时，连续 10 次请求不追加新的 `pi.system` 条目。

<a id="adr-06"></a>

## ADR-06 先做词法检索，embedding 由评测决定

**背景。** pi-ai 1.5.0 没有 embedding 接口。本机实测 `Intl.Segmenter('zh')` 的分词结果可用，Node 24 内置的 SQLite 3.53 支持 FTS5 的 `unicode61` 和 `trigram`。用户决定先不引入 embedding 供应商。

**决策。** 入库时用 `Intl.Segmenter` 预分词，空格连接后写入 FTS5 `unicode61` 表；另建一张 `trigram` 表，用来召回 3 个字符以上、分词切错的子串。查询时两路各取前 20，用 RRF 融合后取前 10。`Embedder` 和 `VectorIndex` 只定义接口，不实现。

**备选。** 一开始就做混合检索：多一个供应商、多一笔费用、多一份要随删除同步清理的数据；在个人资料规模不大时，收益未必能覆盖成本。

**后果与触发条件。** 50 题个人评测集上 Recall@10 < 90%，或者同义改写类问题的召回率 < 70%，就启动 embedding 选型（候选：云 API 或 transformers.js 本地模型），并在这里追加一条 ADR。

**验证。** T-17 的检索评测脚本：不调用模型、不花钱，可以随时重跑。

<a id="adr-07"></a>

## ADR-07 入口先在业务层做幂等，再交给 Pi 的 requestId

**背景。** Pi 的 requestId 只在同一个会话内去重；同一个 requestId 带着不同内容提交时，Pi 会直接返回原来的 submission，不报冲突。

**决策。** `POST /messages` 先在业务事务中写入 `app_ingress_events`，唯一键为 `(owner_id, channel, client_request_id)`，同时保存 `payload_hash`、`conversation_id`，以及由此派生的 `pi_request_id = "<channel>:<client_request_id>"`。哈希不一致返回 409。写入成功后再派发给 Pi；进程重启后，恢复扫描会重新派发状态仍为 `accepted` 的记录。

**后果。** 客户端重试、浏览器重复提交、以后的 webhook 重投都走同一条路径。

**验证。** T-11 的用例 R1、R9、R10。

<a id="adr-08"></a>

## ADR-08 不给模型 shell、文件系统或任意网络访问能力

**决策。** 不安装 `CodingTools`。模型只能调用为本应用编写的业务工具，`owner_id` 由服务端从会话身份注入，不出现在工具参数里。网页抓取由 `kb_capture_url` 工具发起，但抓取本身在作业里执行，并经过 SSRF 防护（协议白名单、DNS 解析后检查 IP、每次重定向重新检查、大小和时间上限）。资料里的文字永远当作数据处理。

**后果。** 少了“万能 agent”的观感，换来可以讲清楚的权限边界。删除和外发类工具在 MVP 中不提供给模型。

<a id="adr-09"></a>

## ADR-09 时间放进每条输入的信封，不放进 system prompt

**背景。** 解析“明天晚上八点”需要知道当前时间和时区。放进 section 违反确定性要求（ADR-05），每次请求都会改动前缀。

**决策。** 入口提交 `content = "[当前时间 2026-11-06 15:02 星期五 Asia/Shanghai]\n" + 用户原话`，同时附上 `entry: { kind: "app.user", data: { text: 原话, at, tz } }`，界面只显示原话。提醒工具只接受带 IANA 时区的完整本地时间，由服务端换算成 UTC 并回显。

**后果。** 时间作为数据留在 transcript 里，事后可以复现解析过程；前缀保持稳定，prompt cache 有效。

<a id="adr-10"></a>

## ADR-10 后台模型调用走专用会话，用 requestId 保证结果可以取回

**背景。** 资料摘要和记忆候选提取（P2）需要调用模型。直接调用 pi-ai 不经过 harness：崩溃后结果丢失，用量也不会记进 `pi.usage`。

**决策。** 每个后台作业在业务事务里记下它的 `pi_conversation_id`，然后向这个专用会话提交 `requestId = job:<job_id>` 的输入，`wait()` 拿到答案，再在业务事务里写回结果。崩溃后重新提交同一个 requestId，会得到已经存在的 submission，不会产生第二次付费调用。

**后果。** 会产生一些孤儿会话：在“会话已创建、ID 尚未写入作业”之间崩溃时出现。它们无害，P3 加一个清理任务。

**验证（T-23，用例 R14）。** 在“模型已回答、业务未写回”的位置杀掉进程，恢复后 faux provider 的 `callCount` 不增加。
