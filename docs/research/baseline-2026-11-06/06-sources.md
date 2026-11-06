# 资料来源与证据索引

## 基线与证据分级

调研日期为 2026-11-06，时区 Asia/Shanghai。优先使用项目作者、官方仓库、npm 发布元数据和平台官方文档。社区项目只用于了解实现方向，不作为框架保证的依据。没有使用转载文章作为关键结论来源。

证据分三类：发布事实由 npm 1.5.0 包和元数据确认；框架语义由发布文档、规范和样例交叉检查；架构、工期、指标和产品策略为本报告的建议。没有执行运行时测试。

## S1 官方发布介绍

[Pi Durable 发布介绍](https://earendil.com/posts/pi-durable/)

用于确认定位、与 Pi coding agent 的关系和扩展理念。介绍页面反映发布背景，当前 API 以版本化材料为准。

## S2 npm 发布元数据

[pi-durable registry 元数据](https://registry.npmjs.org/@earendil-works%2fpi-durable) · [1.5.0 版本元数据](https://registry.npmjs.org/@earendil-works%2fpi-durable/1.5.0)

调研时 latest 为 1.5.0，发布时间 `2026-11-02T10:58:39.550Z`，北京时间 18:58:39.550。engines.node 为 `>=22.19.0`。本地记录见 [npm-metadata.json](sources/npm-metadata.json) 和 [npm-release.json](sources/npm-release.json)。registry 本次未提供有效 gitHead，不能据此把发布包与主分支提交等同。

下载的发布包为 [pi-durable-1.5.0.tgz](sources/pi-durable-1.5.0.tgz)，SHA-512 与 registry 声明一致。仅解压 README、CHANGELOG 和 package.json；未执行包内代码或安装脚本。

## S3 发布包文档

[发布包 README](sources/published-1.5.0/package/README.md) · [发布包 CHANGELOG](sources/published-1.5.0/package/CHANGELOG.md) · [发布包 package.json](sources/published-1.5.0/package/package.json)

核实范围包括：SQLite adapter、resume、requestId、sleepUntil、safe/unsafe 工具重放、compaction、业务 Document、watch、用量、单进程所有权、延迟持久化与 afterRun。CHANGELOG 证实 1.5.0 的破坏性变更和 watchEvents 移除。

## S4 固定源码快照

[pi 提交 2a32a60](https://github.com/earendil-works/pi/commit/2a32a605a9f18a5f0191f65358a2e764b2f69fc7)

完整 SHA 为 `2a32a605a9f18a5f0191f65358a2e764b2f69fc7`。提交时间 UTC 2026-11-05 23:35:09，北京时间 2026-11-06 07:35:09。所有本地平铺源码文件来自该提交，文件名以双下划线替代路径分隔符；顶层 README 与 LICENSE 同样来自该提交。

[Durable README](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/README.md) · [Durable 规范](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/docs/spec.md) · [Durable 发布记录](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/CHANGELOG.md)

关键规范位置：第 4 节事务与所有权；第 5.2 节外部效果；第 5.6 节休眠与唤醒；第 6 节 submission 去重；第 7.3 节工具；第 11 节存储；第 13 节非目标。源码主分支包含 Unreleased 内容，未把新增的 Tx.submission 作为发布版功能推荐。

## S5 官方示例与适配器

[13-chat](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/test/examples/13-chat.ts) · [19-inbox](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/test/examples/19-inbox.ts) · [24-compaction](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/test/examples/24-compaction.ts) · [34-submit-in-commit](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/test/examples/34-submit-in-commit.ts) · [Node SQLite adapter](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/packages/durable/src/storage/sqlite/node.ts)

本轮下载并静态查阅相关示例和文档，没有运行。详细实现需在固定发布依赖下重新进行类型检查和测试。

## S6 官方仓库权限边界

[Pi README 的权限与容器化说明](https://github.com/earendil-works/pi/blob/2a32a605a9f18a5f0191f65358a2e764b2f69fc7/README.md#permissions--containerization)

用于确认默认宿主权限继承和隔离需求。不据此否认其他生态项目可能实现自己的权限层；本方案要求应用明确建立自己的权限边界。

## S7 Cloudflare 官方集成

[Pi Harness 文档](https://developers.cloudflare.com/agents/harnesses/pi/)

用于确认 PiHarness、Lifecycle、唤醒职责及 Agents SDK 与 Pi 1.5 的版本配套。该网页可持续更新，不属于固定源码快照；开始实施时重新核实。

## S8 官方 Cloudflare 示例

[earendil-works/pi-durable-cloudflare](https://github.com/earendil-works/pi-durable-cloudflare)

参考多会话、历史搜索、调度、重连和任务活动 UI。项目明确标注示例缺少认证与限流。本轮仅审阅 README，未执行其测试、部署或安全审计。

## S9 渠道生态参考

[官方 pi-chat](https://github.com/earendil-works/pi-chat) · [社区 pi-durable-telegram](https://github.com/smixs/pi-durable-telegram)

分别用于参考渠道与隔离思路、常驻 Telegram 入口。两者与核心包的关系不同，文档中已区分。没有执行安装命令，没有借用宣传语作为已验证可靠性保证。

## S10 中文全文检索

[SQLite FTS5 官方文档](https://www.sqlite.org/fts5.html)

用于核查 tokenizer 选择和 trigram 的短查询限制。应用层中文分词、混合检索及片段参数为本报告建议，尚未通过实际语料验证。

## S11 其他执行路线

[LangGraph Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) · [Temporal Tasks](https://docs.temporal.io/tasks)

分别用于说明线程检查点与长期 store 的划分、基于任务历史重放的工作流路线。没有进行全面竞品调查、性能压测或特性评分，不以单篇文档推断绝对优劣。

## 本地证据与复核

本地 `sources/` 保留发布包、发布元数据、固定源码文档和必要样例。哈希清单为 [sources-manifest.json](sources/sources-manifest.json)，可用于复核下载内容是否变化。源码许可证保留在 [LICENSE](sources/LICENSE)，其权利归原作者。

文档链接与代码标识做过静态检查；外部平台页面是调研时读取的动态资料，没有全部保存离线副本。本文未证明性能、效果、可用性、费用或安全性达到生产要求。
