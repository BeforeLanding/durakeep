# P0 内核验证报告

- 日期：2026-11-06 · 环境：Windows 11、Node 24.16.0、pnpm 11.7.0、SQLite（node:sqlite 内置）
- 基线：`@earendil-works/pi-durable|pi-ai|chord|pi-schema` 精确 **1.5.0**；全部测试只用 pi-ai 的 faux provider，**没有任何真实模型调用**（`APP_MODE=test` 下构造真实 provider 会抛 `PaidProviderForbidden`；测试进程还会清除所有 `*_API_KEY` 环境变量）。
- 结论：**G0 通过**。K1–K7 全部通过，4 条“待验证”的 ADR（02、04、05，以及 03/05 里的 write 语义）都没有触发回退方案。

## 1. 结果总览

| 项 | 内容 | 结论 | 运行次数 | 位置 |
|---|---|---|---|---|
| K1 | `pi_` 前缀 Pi 存储与 `app_` 表共用一个 `NodeSqliteDatabase`：打开、提交、关闭、重开 | **通过** | 单独 7 轮（另随全量测试多次） | `tests/int/shared-db.test.ts` |
| K2 | 业务事务与 Pi run 交错 1,000 次 | **通过**：无死锁、错误 0、无 `ReadAfterWrite`；1,000 run + 1,000 业务事务约 1.1 s | 单独 7 轮 | 同上 |
| K3 | 运行中 `VACUUM INTO`；用副本启动后未完成的 run 恢复 | **通过**：副本 `integrity_check=ok`，run 恢复，业务行恰好 1 行 | 40 次 + 2 次单次 | `tests/recovery/t05.test.ts` |
| K4 | 工具内读到 run 锚点；同 run 同参得同一 op_key；不同 run 得不同 op_key | **通过** | ≥ 3 轮 + R2 的 40 次重启 | `tests/int/write-idempotency.test.ts` |
| K5 | 偏好不变时连续 10 次请求不追加 `pi.system`；变化后追加 1 次 | **通过**（异步 section 读宿主表） | ≥ 6 轮 | `tests/int/section-write.test.ts` |
| K6 | 带 requestId 的 write 是否去重（只记录） | **去重**：同 id 返回同一 submission；内容不同以第一次为准；会话忙时、重启后重投都成立 | ≥ 6 轮 | 同上 |
| K7 | R1、R2、R3、R8、R15、R16 | **全部通过**，每项 ×20 | 见下表 | `tests/recovery/` |

K7 明细（每个用例 20 次为一组）：

| 用例 | 组数 | 次数 | 说明 |
|---|---|---|---|
| R1 入口重发 | 1 | 20 | `ingress.after_submit` 被杀 → 重发：同一 submission、transcript 一条用户消息 |
| R2 写工具崩溃 | 2 | 40 | `tool.after_business_commit` 被杀 → 重跑返回 `deduplicated`，业务效果恒为 1 |
| R3 流式中崩溃 | 1 | 20 | 重启后约 2.1 s（一次重试退避）完成，不卡在“生成中”，新进程里 faux 只被请求 1 次 |
| R8 存储写入失败 | 2 | 40 | `harness.closed=failed` → 进程退出码 3 → 重启后已接纳的输入仍在，run 完成 |
| R15 连续崩溃 | 2 | 40 | 恒为崩溃 5 次后该工具调用以 `restart_limit` 错误结果结束，run 完成 |
| R16 实例锁 | 2 | 40 | 闯入者被拒（退出码 5），持有者继续完成 run |

附加：`SIGKILL` 在 Windows 上的语义（见 §2）3 轮；`pnpm test` 14 个文件 32 个用例（单元 + 集成）、`pnpm test:recovery` 3 个文件 7 个用例（各 ×20 或 ×40 的故障注入）、`pnpm lint`（depcruise + eslint + tsc）全部通过（最终一次完整运行）。

## 2. T-01：SIGKILL 在 Windows 上的语义

测试：`tests/int/sigkill.test.ts`；子进程注册 `exit`、`beforeExit`、`SIGTERM`、`SIGINT`、`SIGHUP`、`SIGBREAK` 钩子并每 5 ms 写一行。

| 方式 | 结果 |
|---|---|
| 外部 `process.kill(child.pid, "SIGKILL")` | 约 5 ms 内退出；**没有任何钩子执行**；之后不再写入 |
| 自杀 `process.kill(process.pid, "SIGKILL")` | 下一条语句不执行；没有钩子执行 |
| 子进程 `exit` 事件 | `code=1, signal=null`（**不是** `"SIGKILL"`） |

结论：可用于故障注入。驱动不能靠 `signal === "SIGKILL"` 判断被杀，用“没有 RESULT 输出且退出码非 0”。

## 3. 各 ADR 的验证结论

| ADR | 之前 | 之后 | 依据 |
|---|---|---|---|
| ADR-02 一个 SQLite 文件，`pi_`/`app_` 前缀，共用连接队列 | 待验证 | **已定** | K1、K2、K3；R8、R16 在同一文件上同样通过。回退到双文件的方案未启用 |
| ADR-04 写工具 operation key，`replay: "safe"` | 待验证 | **已定** | K4；R2 ×40。run 锚点读得到，不需要 `app.run_meta` 备选方案 |
| ADR-05 检索经工具进 transcript；稳定偏好放确定性 section | 待验证 | **已定** | K5。不需要 `configure({ instructions })` 备选方案（保留为后备） |
| ADR-03、ADR-07 | 已定 | 已定 | 其中“write 带 requestId”的前提由 K6 证实：write 去重，不需要先查 transcript |
| ADR-10 | 待验证（T-23） | 待验证 | P0 范围之外（后台会话） |

没有任何 ADR 的决策内容被修改。ADR 正文只补了验证结论与实现须知（见 DECISIONS）。

## 4. 与文档不一致、已在同一提交里修正的地方

| 发现 | 修正位置 |
|---|---|
| `fauxAssistantMessage` 默认 `stopReason` 为 `"stop"`；带工具调用必须传 `{ stopReason: "toolUse" }`，否则被当成最终回答、工具不会执行 | 05 §10 示例 |
| section 的 `render` 每次请求都会执行（10 次请求渲染 10 次），所以 profile 必须按 `memory_set_revision` 缓存 | 05 §4.2 |
| write 按 requestId 去重，05 §6 里“先查 transcript”的备选不需要 | 05 §6 |
| `run.first` 类型上是可选的（“启动于记录之前的 run 可能没有”），读不到时工具必须报错而不是继续 | 05 §5.2 |
| `Submission.wait()` 的 `answer` 是**助手条目的 ID**（数字），不是消息；取文本要再读条目（实测） | 05 §7 |
| `unanswered` 的 `reason` 不止 `RunFailureReason`（README 另列 `stale`、`run_failed` 等；未实测，仅实测过 `nothing_to_answer`） | 05 §7 |
| R15：工具内的崩溃循环，结局是“该工具调用以 `restart_limit` 错误结果结束，run 继续并完成”，不是 run 以 `restart_limit` 结束 | 08 §4 R15 |
| `backup.mid_vacuum` 无法在进程内注入（`node:sqlite` 同步，语句执行期间事件循环被阻塞）；改为 `before_vacuum` / `after_vacuum`，备份写 `.partial` 后原子改名 | 08 §3 |
| Windows 上被杀进程的 `exit` 事件为 `code=1, signal=null` | 08 §3 |
| 任务卡 T-02 写“`packages/db` 打开 `NodeSqliteDatabase`”，但它来自 chord，违反 ADR-01。实际：`runtime-pi` 打开连接，`db` 只依赖结构性接口 `SqlDatabase` | 03 §2、09 T-02、05 §2 |

## 5. 实现层面的意外（未改设计，但进入 P1 前要知道）

1. **pnpm 11 把“有未决的依赖构建脚本”当作错误**，每次 `pnpm run` 都会失败。已在 `pnpm-workspace.yaml` 把 `@google/genai`、`protobufjs` 显式设为 `allowBuilds: false`，没有执行任何第三方脚本。
2. **TypeScript 取 6.0.3**：`typescript-eslint` 8.72.1 尚不支持 TS 7。
3. **`guardDb` 的局限**：基于 `AsyncLocalStorage`，只覆盖从事务回调的异步链里发起的外层 db 调用；脱离异步上下文（回调里 fire-and-forget）的抓不到。
4. **实例锁**靠 pid 探测，不防 pid 复用。
5. **R3 的“半截回答”**：崩溃发生在流式输出的第一秒内，不会留下 aborted 条目（README 对 `persistWithinMs` 的说明属实）；界面看到的“已显示文字”在崩溃后可能消失，与 README 的持久性边界一致。
6. **R8 用 `PRAGMA query_only = ON` 模拟存储写入失败**，走的是真实的 SQLite 报错路径，但不是真正的磁盘满或只读文件。
7. **R1 只验证了 Pi 层**（同 requestId → 同一 submission）。业务层入口表 `app_ingress_events`（ADR-07）属于 P1/T-11。

## 6. 未覆盖（已登记到 PROGRESS 的“已知缺口”）

- 生成阶段（模型请求）反复崩溃导致 run 以 `restart_limit` 结束的路径。
- 重度并发写入下的备份耗时与对对话提交的阻塞。
- `loadEarlier`、`observe` 在长 transcript 下的行为（T-12）。
- prompt cache 的真实命中（faux 没有缓存）：K5 只证明“文本不变则不追加 `pi.system`”。

## 7. 估算偏差

任务卡合计估算 4 个开发日。本次由 agent 执行，按提交时间墙钟约 30 分钟（不含等待用户确认依赖安装的时间），与人工开发日不可直接换算，所以不据此修改 P1 估算。没有任何一张卡超过估算的 2 倍，也没有因超时而停下。主要的“额外成本”来自 1.5.0 真实类型与文档示例的出入（§4），而不是设计问题。

## 8. 进入 P1 前需要用户决定的事项

1. **是否推送**：本地已有 7 个提交（T-00…T-06 + 文档修正），尚未 `git push`。
2. **CI 工作流**从未在远端运行过（矩阵：ubuntu/windows × Node 22.19.0/24）。推送后第一次运行可能暴露跨平台问题（例如 Linux 上 `process.kill` 的信号语义；也尚未在 Node 22.19.0 上运行过——本机只有 24.16.0）。是否推送后立即检查，还是先在本地再确认 Node 22.19？
3. **`PiRuntime.loadEarlier` 未实现**（T-12 再做），是否接受。
4. **P1 的 T-17 需要你提供个人资料**（检索评测集）——请考虑何时准备。
5. 是否把本次发现的“`Submission.answer` 是条目 ID”等 API 细节整理进 05 的一节“1.5.0 实际行为备忘”（目前散落在各处的修正里）。
