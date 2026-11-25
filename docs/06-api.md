# 06 HTTP 接口

- 版本：v1.0，2026-11-06
- 服务地址 `http://127.0.0.1:${PORT}`（默认端口 4777）。前缀为 `/v1`。请求和响应都是 JSON（UTF-8），文件上传除外。
- 这是本项目自己设计的接口，不是 pi-durable 自带的服务。

## 1. 通用约定

**认证。** 除 `POST /v1/auth/login` 和 `GET /v1/health` 外，所有接口都要求带 `sid` cookie（HttpOnly、SameSite=Strict、Path=/）。缺少或过期时返回 401。

**来源校验。** `POST`、`PATCH`、`DELETE` 请求（包括登录）的 `Origin` 必须与服务自身的 origin 完全相等（协议、主机、端口都比较；`localhost` 与 `127.0.0.1` 不等价），否则返回 403 `origin_mismatch`。没有 `Origin` 头时：带 `Sec-Fetch-Site` 且不是 `same-origin` / `none`（即浏览器发出的跨站请求）同样拒绝；不带该头的非浏览器客户端（curl、CLI）放行。

**幂等。** 会创建资源的 `POST` 接受 `client_request_id`（UUID）。同一个 ID、同样的内容重复提交，返回第一次的结果，状态码为 200 而不是 201/202；同一个 ID、不同内容返回 409 `idempotency_conflict`。

**分页。** `?limit=`（默认 20，最大 100）和 `?cursor=`（不透明字符串）。响应中带 `next_cursor`，没有更多数据时为 null。

**时间。** 字段一律为 UTC 毫秒时间戳（`*_at`）。需要展示本地时间的地方同时返回 `local` 和 `timezone`。

**错误格式：**

```json
{ "error": { "code": "idempotency_conflict", "message": "同一个请求 ID 对应了不同的内容", "details": {} } }
```

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | 参数校验失败，`details.issues` 给出字段 |
| 401 | `unauthenticated` | 未登录或会话过期 |
| 403 | `origin_mismatch` | 跨站请求 |
| 404 | `not_found` | 资源不存在，或不属于当前 owner（两种情况不区分） |
| 409 | `idempotency_conflict` / `conversation_busy` / `revision_conflict` / `invalid_state` | 冲突 |
| 413 | `too_large` | 超过大小限制（JSON 请求体默认上限 1 MB；文件上传另有 2 MB 上限，在 T-13 实现） |
| 422 | `ssrf_blocked` / `unsupported_type` / `robots_disallowed` / `extract_failed` / `login_required` / `permission_denied` / `time_in_past` | 业务规则拒绝（采集类错误码也会出现在作业和资料的 `error_code` 里，不一定是 HTTP 响应） |
| 423 | `locked` | 登录失败次数过多，暂时锁定 |
| 429 | `rate_limited` | 限流 |
| 502 / 504 | `fetch_failed` / `fetch_timeout` | 抓取目标网站失败 / 超时（只出现在作业与资料的 `error_code` 里） |
| 503 | `runtime_unavailable` | Harness 已失效或正在恢复。恢复后的投递暂停状态由认证接口 `GET /v1/admin/health` 返回 |

**限流。** 登录：每分钟 10 次；发消息：每分钟 30 次；采集：每分钟 20 次。按 owner 计数，在内存中计算。

## 2. 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/v1/auth/status` | —（不需要登录） | `{ "initialized", "setup_pending" }`；前端据此显示登录页或首次设置页 |
| POST | `/v1/auth/setup` | `{ "setup_code", "password", "display_name"?, "timezone"? }` | 只在首次设置服务里存在（见下）。设置码错误 401（累计 10 次后 423，需重启换码）；口令弱 400；成功 204 并设置持久 `sid` cookie；已设置 409 |
| POST | `/v1/auth/login` | `{ "password": "...", "remember"?: boolean }`（口令非空，≤256；`remember` 缺省 true） | 204，并设置 `sid` cookie（HttpOnly、SameSite=Strict、Path=/）。`remember=true`：Max-Age=14 天，活跃使用时剩余不足一半即滑动续期；`remember=false`：浏览器会话 cookie，服务端 12 小时后过期、不续期。失败返回 401，`details.attempts_left` 给出锁定前剩余次数；连续失败 5 次锁定 60 s，期间一律返回 423，`error.details.retry_after_ms` 与 `Retry-After` 头（秒）给出剩余时间；登录接口每分钟 10 次，超出返回 429 |
| POST | `/v1/auth/logout` | — | 204，删除会话 |
| POST | `/v1/auth/password` | `{ "current_password", "new_password" }` | 204；当前口令错误 400；新口令需 8–256 字符且不能是单字符重复、顺序串或常见弱口令；成功后删除**除当前会话外**的所有会话；与登录共用限流 |
| GET | `/v1/auth/sessions` | — | `{ items: [{ id, device, created_at, last_seen_at, expires_at, persistent, current }] }`；`id` 为 token 哈希前 16 位；`device` 只存“浏览器 · 系统”摘要，不存完整 User-Agent |
| DELETE | `/v1/auth/sessions/:id` | — | 204；不存在 404 |
| POST | `/v1/auth/sessions/revoke-others` | — | 204，注销当前会话以外的全部会话 |
| GET | `/v1/me` | — | `{ "owner_id", "display_name", "timezone", "capabilities": { "feishu_docs" } }` |
| PATCH | `/v1/me` | `{ "display_name" }`（1–40 字符） | 同 GET |

**首次设置（dev / prod）。** 启动时库里没有 owner，主进程先只起一个设置服务（同一端口，只有 `/v1/health`、`/v1/auth/status`、`/v1/auth/setup` 与静态文件，其余 `/v1/*` 返回 503 `setup_required`），并在终端打印一次性 8 位设置码。网页提交设置码与口令后创建 owner、签发会话，设置服务关闭，进程继续正常启动（各服务启动时就需要 owner_id）。`pnpm cli init` 仍可用；test / demo 模式不进入设置服务。

## 3. 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/conversations` | 列表（只包含 `kind=chat`），按 `last_active_at` 倒序 |
| POST | `/v1/conversations` | `{ "title"?: string }`，返回 201 和会话对象 |
| PATCH | `/v1/conversations/:id` | `{ "title"?, "archived"?: boolean }` |
| GET | `/v1/conversations/:id/entries?before=<entry_id>&limit=50` | 加载更早的条目：`{ "entries": AppEntry[], "has_earlier": boolean }`。`before` 不含，缺省从最新开始；`limit` 1–100；条目按 ID 升序，只含可展示的类型 |
| GET | `/v1/conversations/:id/stream` | SSE，见 §9 |
| POST | `/v1/conversations/:id/messages` | 发送消息，见下文 |
| POST | `/v1/conversations/:id/continue` | 继续一个失败的 run，返回 202 `{ "submission_id" }`。会话忙时返回 409 `conversation_busy`；没有可继续的内容时 run 以 `nothing_to_answer` 结束（不是错误） |
| POST | `/v1/conversations/:id/abort` | 停止当前 run 并撤回排队中的输入。会话变为空闲后返回 `{ "status": "idle" }` |

**发送消息：**

```http
POST /v1/conversations/01J…/messages
{ "client_request_id": "6f1c…", "text": "上次那篇间隔重复的文章主要建议是什么？", "steer": false }
```

```json
202 Accepted
{
  "ingress_id": "01J…",
  "submission_id": "…",
  "status": "dispatched",
  "deduplicated": false,
  "budget_warning": null
}
```

- `client_request_id` 必须是 UUID；`text` 长度为 1–8,000 个字符（按 Unicode 码点计，全空白无效）；`steer` 可选布尔值。
- 已归档的会话不能发送消息，返回 404；别人的会话与不存在的会话一样返回 404。
- 同一个 `client_request_id` + 同样的内容（含同一个会话）重发返回 200 和第一次的结果（`deduplicated: true`）；内容不同、或发往另一个会话，返回 409 `idempotency_conflict`。
- 每分钟最多 30 条（按 owner），超出返回 429。
- `status` 可能是 `accepted`（已持久化但尚未交给 Pi，例如 Harness 正在重启），也可能是 `dispatched`。两者都表示“不会丢失”。
- POST 不等待回答。回答通过 SSE 推送。
- 月度预算已达到 100% 时，`budget_warning` 返回面向用户的提示文本，响应仍为 202 或幂等重试的 200。低于上限时返回 `null`。对话页通过全局流更新超支提示。

**会话对象：**

```json
{ "id": "01J…", "title": "阅读计划", "created_at": 1762412520000, "last_active_at": 1762412600000, "archived": false }
```

**AppEntry：**

```json
{ "id": "<entry_id>", "type": "user", "text": "…", "at": 1762412520000 }
{ "id": "…", "type": "assistant", "text": "间隔重复建议… [1]", "citations": [
    { "n": 1, "chunk_id": 1234, "document_id": "…", "version_id": "…", "title": "…", "loc": "二、方法", "valid": true }
  ], "at": … }
{ "id": "…", "type": "tool", "name": "kb_search", "ok": true, "summary": "命中 4 个片段", "at": … }
{ "id": "…", "type": "event", "kind": "reminder_fired", "data": { … } }
{ "id": "…", "type": "compaction", "at": … }
```

如果引用的片段已经停止使用、已删除或不存在，`valid` 为 `false`，并附带 `invalid_reason`（`revoked` / `purged` / `missing` / `superseded`（资料已有新版本）/ `not_in_run`（本次 run 没有检索到这个片段）/ `unresolved`（正文有 `[n]` 却没有对应条目））。无效引用不带标题、位置等任何资料信息（别人的片段与不存在的片段同为 `missing`）。校验在每次展示时重新进行、不存储：停止使用 / 恢复后，下一次快照里的 `valid` 立即变化。前端对这样的引用标红，不提供跳转。

## 4. 资料

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/documents?status=&tag=&q=&cursor=` | 列表；`q` 按标题前缀匹配 |
| POST | `/v1/documents` | 采集，见下文 |
| GET | `/v1/documents/:id` | 详情，含版本列表 |
| GET | `/v1/documents/:id/versions/:vid/text` | 抽取出的正文（`text/markdown`） |
| GET | `/v1/documents/:id/versions/:vid/raw` | 原始内容，一律 `Content-Type: application/octet-stream` + `Content-Disposition: attachment`（文件名由资料与版本 ID 生成，不含标题）+ `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`；HTML 不会在页面中渲染 |
| PATCH | `/v1/documents/:id` | `{ "title"?, "tags"? }`；`{ "summary" }`（1–1000 字符，编辑当前版本的摘要并把 `summary_edited` 置为 1；之后摘要作业不再覆盖） |
| POST | `/v1/documents/:id/revoke` | 停止使用 |
| POST | `/v1/documents/:id/restore` | 恢复使用 |
| DELETE | `/v1/documents/:id` | 彻底删除，返回 202 和 `job_id`。请求返回时资料已是 `purging`、片段已不可检索；原文 / 正文 / 片段 / 索引由 `purge_document` 作业异步清除，完成后列表与详情都是 404 |
| GET | `/v1/documents/:id/conversations` | `{ items: [{ id, title, archived, last_active_at }] }`：检索结果里出现过这份资料的会话（含已归档），用于彻底删除前归档 |
| GET | `/v1/chunks/:id` | 引用悬停时用：返回 `{ id, document_id, version_id, title, loc, char_start, char_end, text }`；校验 owner 和 `active`，不满足一律 404 |
| GET | `/v1/search?q=&top_k=10` | 资料页全文搜索；与 `kb_search` 使用同一条检索链路（只含 active 片段）。`q` 1–200 字符，`top_k` 1–20。返回 `{ items: [{ chunk_id, document_id, title, source_type, loc, snippet }] }`，`snippet` 为去掉 Markdown 标记、以查询词为中心的约 160 字摘录 |
| POST | `/v1/documents/:id/refresh` | 重新抓取网页 / 飞书资料：202 `{ job_id, created: true }`；已有排队或执行中的抓取作业时 200 返回它。内容有变化则产生新版本（旧版本保留），未变不改动；失败的资料改回 `pending`。文本资料 409 `invalid_state`，已停用 / 删除中的资料 409；与采集共用限流 |

**飞书 / Lark 文档与登录墙。** 飞书文档网页需要登录且由前端脚本渲染，直接抓取只会拿到登录页。识别为飞书链接（`*.feishu.cn`、`*.larkoffice.com`、`*.larksuite.com` 的 `/docx/`、`/docs/`、`/wiki/`）时：配置了 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（飞书自建应用，需开通 `docx:document:readonly`、`wiki:wiki:readonly`，并在文档中“添加文档应用”）则在作业里经开放平台读取文档块并转成 Markdown；未配置则 `POST /v1/documents` 直接返回 422 `login_required`，不建资料。表格、多维表格等返回 `unsupported_type`。腾讯文档、Notion、石墨、钉钉文档同样在提交时返回 `login_required`。其他网址若抓取被重定向到登录页（主机名以 accounts./passport./login./sso. 等开头，或路径含 /login、/signin 等），作业以 `login_required` 失败。应用无权读取文档时为 `permission_denied`。

**采集：**

```json
{ "client_request_id": "…", "type": "url", "url": "https://example.com/post", "tags": ["学习"] }
{ "client_request_id": "…", "type": "text", "title": "会议记录", "text": "…", "tags": [] }
```

上传 Markdown / 文本文件使用 `multipart/form-data`，字段为 `file`、`client_request_id`、`tags`（JSON 字符串）。只收 `.md`、`.markdown`、`.txt`（其他扩展名 422 `unsupported_type`），必须是 UTF-8（否则 400），文件 ≤2 MB（413 `too_large`）。**文件名只用来生成默认标题（去掉路径与控制字符），永远不参与任何文件路径**（S12）。标题优先级：请求里的 `title` > 文档自己的 `#` 标题（Markdown）> 文件名 > 首行文字。

通用规则：`type` 为 `url`、`text` 或 `markdown`；`tags` 至多 10 个、每个 1–32 个字符，去重保序；正文 ≤50 万字符（413）；采集接口每分钟最多 20 次（按 owner，429）；JSON 请求体上限 3 MB（其他接口 1 MB）。`client_request_id` 必须是 UUID：同 ID 同内容重发返回 200 和第一次的结果，同 ID 不同内容返回 409；**不同 ID 但内容相同的文本**去重到已有的资料（`deduplicated: true`，`job_id` 为 null，包括已停止使用的资料）；URL 同一个 owner 只有一份资料，同一个 URL 同一天只有一个作业，隔天再次采集会重新抓取（内容没变就不产生新版本）。已停止使用 / 正在删除的 URL 资料不能重新采集（400）。

```json
202 { "document_id": "…", "job_id": "…", "status": "pending", "deduplicated": false }
```

**资料详情：**

```json
{
  "id": "…", "source_type": "url", "source_uri": "https://…", "title": "…", "status": "ready",
  "tags": ["学习"], "created_at": …, "updated_at": …, "error_code": null,
  "versions": [
    { "id": "…", "captured_at": …, "status": "ready", "char_count": 8123, "parser_version": "readability@0.6+seg1",
      "summary": null, "summary_edited": false, "current": true }
  ]
}
```

## 5. 记忆（P2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/memories?status=confirmed\|candidate\|revoked` | 列表 |
| POST | `/v1/memories` | 手动添加 `{ client_request_id, kind, key, value, scope }`，直接保存为 confirmed |
| PATCH | `/v1/memories/:id` | `{ "value"?, "scope"?, "expected_revision": n }`；revision 不匹配时返回 409 `revision_conflict` |
| POST | `/v1/memories/:id/confirm` | 候选 → 已确认 |
| POST | `/v1/memories/:id/reject` | 候选 → 已拒绝，同时写入 suppression |
| POST | `/v1/memories/:id/revoke` | 停用 |
| POST | `/v1/memories/:id/enable` | 重新启用（revoked → confirmed，revision+1；同 key 已有 confirmed 时它被取代） |
| DELETE | `/v1/memories/:id` | 彻底删除，同时写入 suppression |
| GET | `/v1/memories/:id/revisions` | 历史版本 |

## 6. 提醒与通知（P2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/reminders?status=active\|fired\|cancelled` | 列表；每项带 `local`、`timezone` 和 `next_fire_at` |
| POST | `/v1/reminders` | `{ client_request_id, text, local_datetime, timezone?, document_id? }`；缺省时用 owner 的时区，时间已过去时返回 422 `time_in_past` |
| PATCH | `/v1/reminders/:id` | `{ text?, local_datetime?, timezone?, expected_revision }` |
| POST | `/v1/reminders/:id/cancel` | 取消 |
| GET | `/v1/notifications?unread=1` | 通知列表 |
| POST | `/v1/notifications/:id/read` | 标记已读 |
| POST | `/v1/notifications/read-all` | 全部标为已读 |

提醒对象：

```json
{ "id": "…", "text": "看完《间隔重复的科学》", "local": "2026-11-07 20:00 星期六", "timezone": "Asia/Shanghai",
  "next_fire_at": 1762516800000, "revision": 1, "status": "active", "document_id": "…",
  "last_occurrence": null }
```

## 7. 作业、事件、运维

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/jobs?status=` | 作业列表 |
| GET | `/v1/jobs/:id` | 单个作业（`id`、`kind`、`status`、`attempts`、`max_attempts`、`next_attempt_at`（仅排队中）、`error_code`、`error_message`（面向用户，不含堆栈）、`document_id`） |
| POST | `/v1/jobs/:id/retry` | 只对 `failed` 状态有效：把 attempts 清零，重新排队 |
| POST | `/v1/jobs/:id/cancel` | 对 `queued` 和 `running` 有效 |
| GET | `/v1/outbox?status=&cursor=&limit=` | 按 ID 倒序列出当前 owner 的飞书投递，返回 `{ items, next_cursor }` |
| POST | `/v1/outbox/:id/retry` | 对 `failed` 或 `needs_review` 有效，重置为 `pending`、清零尝试次数并唤醒外发 worker |
| POST | `/v1/outbox/:id/resolve` | 对 `needs_review` 有效。接受 `{ "resolution": "succeeded" \| "failed" }`，标记已送达或放弃 |
| GET | `/v1/events?level=&cursor=&limit=` | 当前 owner 的运行报告与运维事件，按 `created_at`、`id` 倒序 |
| GET | `/v1/health` | 不需要认证，只返回 `{ "ok": true }` 或 503 |
| GET | `/v1/admin/health` | 运行时长、数据库大小、排队和失败作业数、未读通知、最近备份、Pi 报告、投递暂停和孤儿后台会话数 |
| GET | `/v1/admin/runbook` | 以纯文本返回运维与升级手册 |
| GET | `/v1/usage?month=2026-11` | 按模型汇总的 token 数和估算费用，以及预算上限和使用比例 |
| GET | `/v1/export` | 返回包含资料、记忆和提醒的 ZIP（格式见 04 §6，采用存储方式并在内存中构造） |
| POST | `/v1/admin/backup` | 立即入队并返回 202 `{ "job_id": "…" }`，通过作业接口查结果。可带 `{ "client_request_id": "<UUID>" }`；同 ID 重试返回 200 和原作业 |
| POST | `/v1/admin/delivery/resume` | 人工确认后恢复投递，返回 200 `{ "delivery_paused": false }`，立即唤醒 Scheduler 和 OutboxWorker。重复调用仍返回相同状态 |

`/v1/events` 返回 `{ items, next_cursor }`。事件含 `id, level, kind, ref, message, created_at`，其中 `ref` 是已解析的 ID 与状态对象，`message` 是状态码。可按 `info`、`warn` 或 `error` 过滤，`limit` 默认 20、最大 100；无效过滤或游标返回 400。

外部投递记录包含 `id, channel, occurrence_id, status, attempts, next_attempt_at, error_code, created_at, updated_at`。`status` 可取 `pending`、`dispatching`、`succeeded`、`failed`、`unknown`、`needs_review`。`next_attempt_at` 仅在待发送时非空。游标是上一页最后一条记录的 ID，`limit` 默认 20、最大 100。列表与操作响应只返回投递元数据。两种操作成功返回 200 和更新后的记录。记录不属于当前 owner 或不存在时返回 404，状态冲突返回 409 `invalid_state`。人工放弃的记录以 `failed` 和 `error_code: "abandoned"` 表示。

认证健康接口返回 `uptime_ms, db_size_bytes, queued_jobs, failed_jobs, unread_notifications, last_backup_at, pi_reports, delivery_paused, orphaned_background_conversations`。数据库大小为 SQLite 逻辑页数乘页大小，不另计 WAL 文件、blob 或备份。最近备份时间来自最新有效备份对的清单，无备份时为 `null`。Pi 报告为 `{ total, by_kind }`，按原始报告种类累计。孤儿后台会话计数来自最近一次启动扫描。

`feishu_configured` 表示当前进程加载了有效的飞书配置。`outbox_pending` 和 `outbox_needs_review` 分别统计当前 owner 的待发送和待核对记录。健康接口不返回凭据，也不探测飞书。

`GET /v1/usage` 缺省查询当前 UTC 自然月，显式的 `month` 必须为 `YYYY-MM`。响应包含 `month`、`models`（每项为 `model, input_tokens, output_tokens, cache_read_tokens, cost_usd`）、`total_cost_usd`、`monthly_budget_usd`、`usage_ratio`、`warning_80`、`exceeded_100`。使用比例为费用除以当前预算（0.8 表示 80%），历史查询也使用当前预算。

运行时每分钟、UTC 月界、用量查询、发送消息、设置更新及模型作业领取前同步累计用量；用量增量按同步观测月份入账。升级前已有累计量作为初始基线，缺少逐笔时间戳的未观测用量无法追溯到精确月份。优先用运行时上报的费用增量；该值为零时，用新增 token 按模型目录价估算。

达到 80% 或 100% 时分别生成一条当月去重的站内通知。达到 100% 后，`summarize` 和 `extract_memory` 保持排队且不消耗重试次数，已领取的作业可以完成。调高预算至当月用量以上或进入新月份会重新检查队列。其他作业和站内提醒按各自的调度规则继续运行。

## 8. 设置（P3）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/settings` | `{ chat_model, monthly_budget_usd, timezone, backup_keep }` |
| PATCH | `/v1/settings` | 部分更新上述字段并返回完整设置。未知字段或无效值返回 400 |

`chat_model` 仅支持 `deepseek-flash` 和 `deepseek-v4-pro`，未设置时使用合法的 `CHAT_MODEL`，否则使用 `deepseek-flash`。新建的 dev/prod 会话采用该选项。test/demo 继续使用 faux。月度预算默认 5 美元，只接受有限正数。备份保留默认 7 份，只接受正的安全整数。时区使用 IANA 名称并写入 `app_owners.timezone`，从此用于 `/v1/me`、新输入信封和提醒缺省时区。

## 9. SSE

### 9.1 会话流：`GET /v1/conversations/:id/stream`

```text
event: snapshot
id: <resume cursor>
data: {"entries":[…],"live":{"running":true,"partialText":"间隔重复建议…","tools":[],"queued":0},"hasEarlier":true}

event: snapshot
id: …
data: {…}

: keep-alive   （每 15 秒一次）
```

- 每次 Pi 提交都会推送一次完整的 `ConversationSnapshot`，服务端按 100 ms 节流（尾部节流：窗口内只发最新的一个，首个立即发送）。单用户场景下快照最多包含 100 条条目，直接发送全量比发送增量 ops 简单，也更不容易出错。
- `id` 是恢复游标（不透明的数字串）。空会话的第一个快照没有 `id`。`live.runFailure` 带 `reason`、可选 `detail` 和中文 `message`（05 §9 的对照表）。
- 条目的 `at` 只有用户条目有（来自输入信封的 `app.user`）；助手 / 工具条目没有时间戳。
- 不属于当前 owner 的会话与不存在的会话一样返回 404 JSON，不开流；客户端断开后服务端立即释放观察者（实测约 35 ms）。
- 重连时浏览器会自动带上 `Last-Event-ID`，服务端用它作为 `transcript.resume` 游标：**重连后的快照只含游标之后错过的条目**（可以为空），客户端按条目 `id` 与已有内容合并，不要整体替换。游标不是数字（无效）时从最新窗口开始；游标超前于最新条目时从空开始，等待新条目。
- `entries` 中助手条目的引用已经过服务端校验（`valid` 字段）。

### 9.2 全局流：`GET /v1/stream`

```text
event: notification   data: {"id":"…","kind":"reminder","title":"提醒","body":"…","link":"/documents/…"}
event: job            data: {"id":"…","kind":"ingest_url","status":"succeeded","document_id":"…"}
event: runtime        data: {"status":"ok"|"restarting"|"failed"}   （连接建立后立即发一次当前状态）
event: unread         data: {"count":3}
event: budget         data: {"budget_warning":null}
```

`budget` 在连接建立及超支状态变化时推送。值为提示文本或 `null`。

## 10. CLI（`apps/server/src/cli.ts`）

| 命令 | 作用 |
|---|---|
| `pnpm cli init [--timezone=Asia/Shanghai]` | 设置口令（至少 8 个字符）和时区，创建 owner。终端中口令不回显且需输入两次；管道输入时按行读取 stdin（脚本、测试用） |
| `pnpm cli passwd` | 修改口令（会让所有会话失效）。服务运行时被实例锁拒绝 |
| `pnpm cli backup` | 停服时获取实例锁并直接备份，打印 SQLite 路径。运行中的实例占锁时，CLI 打印经认证的本机 HTTP 操作指引 |
| `pnpm cli restore <file>` | 停服时获取实例锁。指定 SQLite 文件，同目录保留原命名的 blob 清单。校验后恢复、重放彻底删除并暂停投递 |
| `pnpm cli export <dir>` | 停服时获取实例锁，在目标目录生成 `export-<UTC 时间戳>.zip` 并打印路径。格式与 HTTP 导出一致 |
| `pnpm demo` | 构建前端并启动零费用演示。默认使用临时数据目录，先索引 3 篇自撰样例。终端显示本机 URL、公开口令 `demodemo` 和推荐体验语句。启动器清除 `*_API_KEY` 环境变量 |

演示对话支持「收藏：…」「记住我喜欢简短总结」「明天晚上八点提醒我复习间隔重复」和数字分钟相对提醒，如「10 分钟后提醒我喝水」。提醒以信封中的时区为准，未指定分钟数时示范次日 20:00。普通提问检索资料，命中时附引用，无命中时以「现有资料不足」开头。真实供应商与演示会话无关。

在线备份可向当前服务的 `127.0.0.1:<PORT>` 发送 `POST /v1/admin/backup`，带上已有会话的 `sid` cookie。CLI 以环境变量 `PORT`（默认 4777）显示本机地址。
