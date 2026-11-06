# 知识库与长期记忆设计

## 分开管理四类信息

**原始知识**是用户收藏的网页、文档、笔记和附件。需要可定位的来源、不可变内容版本以及删除策略。

**会话记录**是当时用户说了什么、模型引用了什么、执行过什么。pi-durable transcript 保存过程，但它不是所有资料的主存储。

**长期记忆**是对用户或项目有持续作用的结构化事实与偏好，如“回顾希望简短”“项目使用 TypeScript”。需要来源、时间、确认状态和冲突处理。

**行动状态**是待办、提醒、授权和操作回执。用确定性业务状态管理，不能让语言模型摘要决定一个提醒是否已经完成。

本文除引用处外均为建议设计。pi-durable 的 compaction 只改变模型可见上下文，保留旧条目；不能替代上述分层。[官方 Compaction 说明](sources/published-1.5.0/package/README.md)

## 资料导入流水线

采集 → 校验 → 保存原始版本 → 解析 → 分块 → 建索引 → 生成摘要 → 标记可检索。

各阶段记录 parser_version、内容哈希、输出版本和失败原因。失败重试只重做未完成或失效阶段；摘要失败不应让已成功解析的文档不可检索。需要 OCR 的扫描 PDF 显示“待 OCR”，不能把空文本视作成功。

首版支持纯文本、Markdown 与普通网页。网页保留 canonical URL、抓取时间和内容哈希，但不单凭 URL 判重；同一个 URL 的不同内容形成 document_version。去除导航噪声时保留可回溯原文，防止解析器删掉重要限定。

业务对象建议：

- Document：id、owner_id、source_type、source_uri、title、created_at、status。
- DocumentVersion：id、document_id、content_hash、captured_at、parser_version、raw_uri、text_uri、deletion_epoch。
- Chunk：id、document_version_id、ordinal、heading_path、page_or_paragraph、char_start、char_end、text_hash、token_count。
- IndexRecord：chunk_id、index_version、embedding_model、embedding_dimensions、status。

来源定位对应保存的文档版本；网页后来修改时，历史回答仍指向当时版本，不悄悄跳转到新的内容。

## 中文检索策略

从混合检索起步：标题、标签、中文分词后的关键词召回，加语义向量召回；合并排序后，必要时重排，再选择片段进入模型上下文。按 owner_id、资料集合、版本状态和删除标记过滤。授权过滤必须在结果返回与引用读取时再次执行。

SQLite FTS5 可作为词法检索基础，但默认 Unicode tokenizer 不是中文语义分词器。建议应用层预分词后建立 FTS 字段，或评估专用 tokenizer；trigram 可作为长子串补充，但短于三个 Unicode 字符的全文查询有明确限制，不能独自解决“两字词”搜索。[SQLite FTS5 tokenizer 文档](https://www.sqlite.org/fts5.html)

初始参数作为可调实验值：片段约 400–800 tokens，重叠约 60–100 tokens；词法与向量各取前 20，融合后取约 10，再选择 4–8 个片段进入回答。优先按标题和段落边界切分，避免把表格解释和内容拆开。上述数值不是效果保证，最终由个人资料评测调整。

第一版无需立刻引入独立向量数据库。先用可替换 VectorIndex 接口，在已知小规模下用经测试的本地实现；若延迟、内存或资料数量超过预算，再选专用存储。本轮没有验证具体向量扩展、embedding 模型或中文 tokenizer 的兼容性，因此不指定未经验证的软件组合。

embedding 模型变化后用新 index_version 全量重建并切换，不能混合不同模型或维度。缓存键至少包含文档版本、模型版本与删除版本。

## 带引用问答流程

1. 解析用户问题与资料范围；必要时作有限查询改写，并保存原始问题。
2. 从已授权且未删除的资料召回片段，保留每个片段的 source_ref。
3. 模型只根据选中片段形成事实性结论，把建议与推断标明。
4. 输出结构化 citations，包含 document_id、version_id、chunk_id、位置和支持的 claim_id。
5. 服务端验证引用对象存在、版本一致、用户仍可访问；不存在的引用拒绝显示为有效来源。
6. 展示来源片段与原文位置。需要联网补充时明确标为外部新资料，避免假装来自私人库。

引用 ID 校验只能证明引用存在，不能证明它支持结论。评测必须另查语义支持、遗漏限定、来源冲突和过时信息。资料不足时返回可回答部分与缺失项，不编造页码或引用。

## 长期记忆的数据契约

每条 Memory 保存：id、owner_id、kind、key、value、scope、status、source_refs、valid_from、valid_to、confirmed_at、updated_at、revision、supersedes_id 与 deletion_epoch。

kind 建议先限制为 preference、profile_fact 和 project_context。操作状态属于任务系统，不塞进 memory。status 包括 candidate、confirmed、superseded、revoked；数值 confidence 可以帮助排序，但不能代替用户确认或来源可信度。

示例：“我希望回顾简短一点”可形成 key 为 `review.verbosity` 的用户偏好；“假如我每天跑步”不能形成“用户每天跑步”的事实。用户显式要求记住可以直接保存；模型从聊天推断出的信息进入 candidate，敏感推断默认不自动提取。

记忆作用域区分全局、项目和临时会话。当次明确指令优先；项目要求优先于同类全局默认。记忆对之间发生冲突时保留变更链，以最新确认且仍有效的记录作为当前值，不能把互斥事实一起注入提示词。

## 提取与注入

会话结束后异步生成候选，使用 `(source_entry_id, extractor_version)` 去重，避免每次重新扫描整段历史。首次只在界面提供候选确认；明确记忆的写入通过业务工具同步完成。

若采用 Pi `afterRun` 做后台整理，应注意 Submission.wait 在最终回答时即可完成，而 after-run 子任务可能仍未结束、会话仍忙碌。UI 不应把这两种完成混为一谈；可先使用独立业务队列减少耦合。[官方 afterRun 说明](sources/published-1.5.0/package/README.md)

每次模型调用只注入少量相关且当前有效的记忆，设置 token 预算。建议从约 1,000 tokens 开始试验：稳定偏好占少量，其余由当前项目和问题检索决定。长期存储增加不意味着每次提示词同比增加。

动态提示词记录“本次使用的 memory ID 与 revision”，有助于解释为什么生成某种建议。原文中的指令与用户指令严格分层，检索结果始终属于不可信内容。

## 删除与遗忘

需要提供两个清楚的操作：停止使用，以及彻底删除。

停止使用立即设置 revoked 或 tombstone，阻止检索、候选提取、缓存复用及后续提示注入。删除或撤销发生在后台任务运行期间时，任务提交前重新检查 deletion_epoch，防止旧任务把资料写回来。

彻底删除覆盖原文、提取文本、chunks、embedding、摘要、记忆证据、缓存及可关联日志。还要检查 transcript 和 compaction summary 是否已经复制内容；仅删除知识库记录并不能从旧对话中移除信息。

应用层不能直接篡改 Pi 内部历史表。若没有经过验证的细粒度清除接口，MVP 应明确限制：受影响会话停止继续使用，并采用经验证的会话重建、存储导出重建或受影响存储整体销毁流程。实施前验证这些路径；没有验证前只承诺逻辑遗忘，不能宣传物理彻底删除。

备份按保留期过期，记录删除请求以防旧备份恢复后重新启用已删资料。云模型或外部连接器已经收到的内容受相应服务数据政策约束，不能由本地删除按钮保证清除。

## 评测与持续改进

建立小而稳定的真实问题集，覆盖：精确关键词、中文两字词、同义表达、跨文档综合、用户偏好冲突、版本变化、无答案问题、被删除资料和恶意提示注入。

分开测量检索召回、引用定位有效性、引用语义支持、答案完整性、记忆准确性和删除传播。只观察“回答看起来不错”会掩盖检索失败。每次改变 chunk、tokenizer、embedding 或 prompt，都在相同问题集上对比，不把模型升级默认当作质量提升。
