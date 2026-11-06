# 10 资料来源与证据索引

- 版本：v1.1，2026-11-06
- S1–S11 来自原调研，原文和本地快照都在 `D:\Agent\pi-durable-personal-agent-research-20261106\06-sources.md` 和 `sources/`，这里只列摘要。S12 起是本版新增的内容。

## 证据分级

| 等级 | 含义 | 例子 |
|---|---|---|
| A 发布事实 | npm 发布包或元数据可以直接证实 | 版本号、依赖、导出的模块、模型目录 |
| B 框架语义 | 发布包 README 与规范、示例相互印证 | 去重、重放、section 的确定性 |
| C 本机实测 | 在本机运行、不花钱的小实验 | FTS5、Intl.Segmenter |
| D 设计建议 | 本项目的判断，需要用测试或评测证明 | ADR、参数、估算 |

## 原调研来源（S1–S11）

| ID | 来源 | 用途 | 等级 |
|---|---|---|---|
| S1 | [Pi Durable 发布介绍](https://earendil.com/posts/pi-durable/) | 定位 | B |
| S2 | [npm registry 1.5.0](https://registry.npmjs.org/@earendil-works%2fpi-durable/1.5.0) | 版本、发布时间、engines，SHA-512 已核验 | A |
| S3 | 发布包 README、CHANGELOG、package.json（原调研 `sources/published-1.5.0/`） | 功能判断的基线 | A/B |
| S4 | [pi 提交 2a32a60](https://github.com/earendil-works/pi/commit/2a32a605a9f18a5f0191f65358a2e764b2f69fc7) 的规范与源码 | 规范章节定位；不使用其中未发布的 API | B |
| S5 | 官方示例 13-chat、19-inbox、24-compaction、34-submit-in-commit；Node SQLite adapter | 用法 | B |
| S6 | [Pi README 权限说明](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/README.md#permissions--containerization) | 安全边界 | B |
| S7 | [Cloudflare Pi Harness](https://developers.cloudflare.com/agents/harnesses/pi/) | 部署备选方案；跨 minor 版本的存储兼容性提醒 | B（动态页面） |
| S8 | [pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare) | UI 参考；示例缺少认证 | D |
| S9 | [pi-chat](https://github.com/earendil-works/pi-chat)、[pi-durable-telegram](https://github.com/smixs/pi-durable-telegram) | 渠道参考，未经审计 | D |
| S10 | [SQLite FTS5](https://www.sqlite.org/fts5.html) | 分词器与 trigram 的限制 | B |
| S11 | [LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Temporal Tasks](https://docs.temporal.io/tasks) | 替代路线 | B |

## 本版新增

### S12 pi-ai 1.5.0 发布包（A）

- 来源：`npm pack @earendil-works/pi-ai@1.5.0`，SHA-512 与 registry 的 integrity 一致（2026-11-06 核验）。
- 证实的内容：`dist/providers/` 下有 `deepseek`（`deepseekProvider()`，`openai-completions` 协议，读取 `DEEPSEEK_API_KEY`）和 `faux`（`fauxProvider`、`fauxAssistantMessage`、`fauxToolCall`、`fauxText`）；`data/deepseek.json` 中有 `deepseek-flash` 和 `deepseek-v4-pro` 两个模型，以及它们的上下文长度、输出上限、目录价和 thinking 级别映射；整个包中没有 embedding 相关模块。
- 局限：目录价没有和 DeepSeek 官方价目页核对。

### S13 chord 1.5.0 发布包（A）

- 来源：`npm pack @earendil-works/chord@1.5.0`，SHA-512 已核验。
- 证实的内容：`dist/sqlite/node.d.ts` 中的 `NodeSqliteDatabase`（基于 `node:sqlite` 的 `DatabaseSync`，有 `exec`、`run`、`runCounted`、`get`、`all`、`transaction`、`close`，所有操作排进一个队列；构造函数公开）；`openNodeSqliteDatabase(path, { walAutoCheckpointPages, busyTimeoutMs })`，busy timeout 默认 5,000 ms。

### S14 pi-durable 1.5.0 发布包 README 补充章节（B）

原调研已经保存了这个文件（`sources/published-1.5.0/package/README.md`）。本版另外引用了以下章节：Per-Conversation Agent（`maxTurns`）、Settings（compaction 的 `modelOverrides`）、Busy Conversations（`entry` 自定义 kind、write 立即追加、`continue`）、Storage（`prefix`，与宿主表共享适配器）、Errors（三条规则、`harness.closed`）、Watching（窗口 50/100、`ConversationTranscript`）、Hooks（`afterRun` 的时序）。

### S15 规范中的类型定义（B）

原调研快照中的 `packages__durable__docs__spec.md`：
- §5.1 `TaskRuntime`（`memo`、`sleepUntil`、`now`、`setTimer`）以及 `TaskDefinition`、`TaskOptions`（`background`、`abandonOnRestart`）；
- §7.4 中关于 section 渲染必须确定的要求（“any change in rendered text … appends a system delta and invalidates provider prompt caches”）；
- `ToolExecutionApi`（`taskId`、`conversationId`、`callId`、`commit`、`memo`、`createTask`、`executeTool`、`snapshot`）；
- `GenerationHooks`（`beforeRequest` 只对单次请求生效）。

### S16 本机实测（C）

2026-11-06，Windows 11，Node v24.16.0：
- `node:sqlite` 内置 SQLite 3.53.0；FTS5 的 `unicode61` 和 `trigram` 表都能创建；`DatabaseSync.prototype.loadExtension` 存在。
- `Intl.Segmenter('zh', {granularity:'word'})` 的分词样例见 01 §4.5。
- 只运行了上面这些片段；没有安装项目依赖，没有调用模型。

## 未验证事项

见 [01 §9](01-research.md#9-仍未验证的事项)，都已经对应到 P0 或 P1 的任务。
