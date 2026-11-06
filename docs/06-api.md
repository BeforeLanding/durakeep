# 06 HTTP 接口

- 版本：v1.0，2026-11-06
- 服务地址 `http://127.0.0.1:${PORT}`（默认端口 4777）。前缀为 `/v1`。请求和响应都是 JSON（UTF-8），文件上传除外。
- 这是本项目自己设计的接口，不是 pi-durable 自带的服务。

## 1. 通用约定

**认证。** 除 `POST /v1/auth/login` 和 `GET /v1/health` 外，所有接口都要求带 `sid` cookie（HttpOnly、SameSite=Strict、Path=/）。缺少或过期时返回 401。

**来源校验。** `POST`、`PATCH`、`DELETE` 请求的 `Origin` 必须等于服务自身的 origin，否则返回 403 `origin_mismatch`。

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
| 409 | `idempotency_conflict` / `conversation_busy` / `revision_conflict` | 冲突 |
| 413 | `too_large` | 超过大小限制 |
| 422 | `ssrf_blocked` / `unsupported_type` / `time_in_past` | 业务规则拒绝 |
| 423 | `locked` | 登录失败次数过多，暂时锁定 |
| 429 | `rate_limited` | 限流 |
| 503 | `runtime_unavailable` / `delivery_paused` | Harness 已失效或正在恢复 |

**限流。** 登录：每分钟 10 次；发消息：每分钟 30 次；采集：每分钟 20 次。按 owner 计数，在内存中计算。

## 2. 认证

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/v1/auth/login` | `{ "password": "..." }` | 204，并设置 `sid` cookie；失败返回 401；锁定时返回 423，带 `retry_after_ms` |
| POST | `/v1/auth/logout` | — | 204，删除会话 |
| GET | `/v1/me` | — | `{ "owner_id", "display_name", "timezone" }` |

## 3. 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/conversations` | 列表（只包含 `kind=chat`），按 `last_active_at` 倒序 |
| POST | `/v1/conversations` | `{ "title"?: string }`，返回 201 和会话对象 |
| PATCH | `/v1/conversations/:id` | `{ "title"?, "archived"?: boolean }` |
| GET | `/v1/conversations/:id/entries?before=<entry_id>&limit=50` | 加载更早的条目（`AppEntry[]`） |
| GET | `/v1/conversations/:id/stream` | SSE，见 §9 |
| POST | `/v1/conversations/:id/messages` | 发送消息，见下文 |
| POST | `/v1/conversations/:id/continue` | 继续一个失败的 run。会话忙时返回 409 `conversation_busy` |
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
  "deduplicated": false
}
```

- `text` 长度为 1–8,000 字符。
- `status` 可能是 `accepted`（已持久化但尚未交给 Pi，例如 Harness 正在重启），也可能是 `dispatched`。两者都表示“不会丢失”。
- POST 不等待回答。回答通过 SSE 推送。

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
{ "id": "…", "type": "event", "kind": "reminder_fired", "text": "提醒：看完《间隔重复的科学》", "at": … }
{ "id": "…", "type": "compaction", "at": … }
```

如果引用的片段已经停止使用、已删除或不存在，`valid` 为 `false`，并附带 `invalid_reason`（`revoked` / `purged` / `missing`）。前端对这样的引用标红，不提供跳转。

## 4. 资料

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/documents?status=&tag=&q=&cursor=` | 列表；`q` 按标题前缀匹配 |
| POST | `/v1/documents` | 采集，见下文 |
| GET | `/v1/documents/:id` | 详情，含版本列表 |
| GET | `/v1/documents/:id/versions/:vid/text` | 抽取出的正文（`text/markdown`） |
| GET | `/v1/documents/:id/versions/:vid/raw` | 原始内容，带 `Content-Disposition: attachment`；HTML 以附件方式返回，不在页面中直接渲染 |
| PATCH | `/v1/documents/:id` | `{ "title"?, "tags"? }`；P2 起支持 `{ "summary" }`（会把 `summary_edited` 置为 1） |
| POST | `/v1/documents/:id/revoke` | 停止使用 |
| POST | `/v1/documents/:id/restore` | 恢复使用 |
| DELETE | `/v1/documents/:id` | P2：彻底删除，返回 202 和 `job_id` |
| GET | `/v1/chunks/:id` | 引用悬停时用：返回片段文本、所属资料和位置；校验 owner 和 `active` |
| GET | `/v1/search?q=&top_k=10` | 调试和资料页搜索；与 `kb_search` 使用同一条检索链路 |

**采集：**

```json
{ "client_request_id": "…", "type": "url", "url": "https://example.com/post", "tags": ["学习"] }
{ "client_request_id": "…", "type": "text", "title": "会议记录", "text": "…", "tags": [] }
```

上传 Markdown 文件使用 `multipart/form-data`，字段为 `file`、`client_request_id`、`tags`（JSON 字符串），文件 ≤2 MB。

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
| DELETE | `/v1/memories/:id` | 彻底删除，同时写入 suppression |
| GET | `/v1/memories/:id/revisions` | 历史版本 |

## 6. 提醒与通知（P2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/reminders?status=active\|fired\|cancelled` | 列表；每项带 `local`、`timezone` 和 `next_fire_at` |
| POST | `/v1/reminders` | `{ client_request_id, text, local_datetime, timezone, document_id? }`；时间已过去时返回 422 `time_in_past` |
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
| POST | `/v1/jobs/:id/retry` | 只对 `failed` 状态有效：把 attempts 清零，重新排队 |
| POST | `/v1/jobs/:id/cancel` | 对 `queued` 和 `running` 有效 |
| GET | `/v1/events?level=&cursor=` | `app_events` 列表 |
| GET | `/v1/health` | 不需要认证，只返回 `{ "ok": true }` 或 503 |
| GET | `/v1/admin/health` | P3：运行时长、数据库大小、待执行和失败的作业数、未读通知数、最近一次备份、Pi 报告计数、投递是否暂停 |
| GET | `/v1/usage?month=2026-11` | 按模型汇总的 token 数和估算费用，以及预算上限和使用比例 |
| GET | `/v1/export` | 以流的形式返回 zip（格式见 04 §6） |
| POST | `/v1/admin/backup` | P3：立即备份，返回 `job_id` |
| POST | `/v1/admin/delivery/resume` | P3：恢复备份后，人工确认恢复投递 |

## 8. 设置（P3）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/settings` | `{ chat_model, monthly_budget_usd, timezone, backup_keep }` |
| PATCH | `/v1/settings` | 只能修改上述字段；`chat_model` 只能是 `deepseek-flash` 或 `deepseek-v4-pro` |

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

- 每次 Pi 提交都会推送一次完整的 `ConversationSnapshot`，服务端按 100 ms 节流。单用户场景下快照最多包含 100 条条目，直接发送全量比发送增量 ops 简单，也更不容易出错。
- 重连时浏览器会自动带上 `Last-Event-ID`，服务端用它作为 `transcript.resume` 游标，只补发错过的部分；游标失效时从最新窗口开始，并设置 `hasEarlier: true`。
- `entries` 中助手条目的引用已经过服务端校验（`valid` 字段）。

### 9.2 全局流：`GET /v1/stream`

```text
event: notification   data: {"id":"…","kind":"reminder","title":"提醒","body":"…","link":"/documents/…"}
event: job            data: {"id":"…","kind":"ingest_url","status":"succeeded","document_id":"…"}
event: runtime        data: {"status":"ok"|"restarting"|"failed"}
event: unread         data: {"count":3}
```

## 10. CLI（`apps/server/src/cli.ts`）

| 命令 | 作用 |
|---|---|
| `pnpm cli init` | 交互式设置口令和时区，创建 owner |
| `pnpm cli passwd` | 修改口令（会让所有会话失效） |
| `pnpm cli backup` | 服务运行时通过 HTTP 调用备份；服务停止时直接执行 |
| `pnpm cli restore <file>` | 要求服务已停止；恢复后把投递设为暂停 |
| `pnpm cli export <dir>` | 离线导出 |
| `pnpm demo` | 演示模式：faux 模型、临时数据目录、预置样例资料、固定口令 `demo` |
