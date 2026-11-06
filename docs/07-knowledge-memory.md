# 07 知识库与长期记忆

- 版本：v1.0，2026-11-06
- 依据：原调研 `04-knowledge-and-memory.md` 中的分层原则全部保留（原始知识、会话记录、长期记忆、行动状态分开管理）。本版补充可以直接实现的参数和算法。数值都是**初始实验值**，以个人评测集的结果为准调整。

## 1. 采集流水线

```text
采集请求 → 规范化与去重 → 抓取或读入 → 写入原始 blob → 抽取正文 → 分块 → 分词 → 写入 FTS → ready
                                                                          ↘（P2）摘要作业
```

每完成一个阶段，就写入作业的 `checkpoint_json`，例如 `{"fetched":"<raw_hash>","extracted":"<text_hash>","chunked":true}`。重试时跳过已完成的阶段。摘要失败不影响资料的 `ready` 状态。

### 1.1 URL 规范化

小写 scheme 和 host；去掉默认端口和 `#fragment`；去掉 `utm_*`、`spm`、`from` 等追踪参数；其余 query 参数按键排序。规范化后的结果写入 `source_uri`，用于同一 owner 下的唯一性判断。同一个 URL 再次采集时，如果内容哈希没变，就判定为重复（`deduplicated: true`）；内容变了则生成新版本。

### 1.2 抓取（SSRF 防护，ADR-08）

- 只允许 http 和 https，端口只允许 80、443 或 URL 中显式写出的端口。
- 先做 DNS 解析，**所有**解析出的 IP 都必须是公网地址。拒绝的范围包括：`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`0/8`、`192.0.0/24`、`198.18/15`、文档用的测试网段、`224/3`（组播与保留）、`::`、`::1`、`fc00::/7`、`fe80::/10`、`fec0::/10`、`ff00::/8`、`2001:db8::/32`，以及 IPv4-mapped / 兼容、NAT64（`64:ff9b::/96`）、6to4（`2002::/16`）地址（按内嵌的 IPv4 判断）；`localhost`、`*.localhost`、`*.internal`、`*.local`、`metadata.google.internal` 等主机名在解析之前就拒绝。解析不了的字符串一律不放行。
- **把连接固定到已经检查过的 IP**，防止 DNS 重绑定：每一跳只解析一次，检查通过后用 Node 内置 `http/https.request` 的 `lookup` 选项把连接钉在第一个已检查的 IP 上（`Host` 头与 TLS 的 SNI / 证书校验仍用原主机名）。**与原方案不同：不引入 `undici`**，T-13 实测这样足够（S8：每跳只解析一次、`never-resolves.invalid` 这类系统 DNS 里不存在的域名也能连上，证明没有触发第二次解析）。IP 字面量（含 `2130706433`、`0x7f.1`、`[::ffff:7f00:1]` 等写法，URL 解析后统一为标准形式）直接检查，不经过 DNS。
- 手动处理重定向，最多 5 次，每次都重新执行以上检查（协议、端口、主机名、全部 IP）；端口只允许 80、443 和**原始 URL 中显式写出的端口**，重定向到别的非标准端口会被拒绝。
- 限制：响应体最大 5 MB（流式计数，超出立即中断；声明的 `Content-Length` 超限直接拒绝）；总时长 20 s（含全部重定向）；请求带 `Accept-Encoding: identity`，不接受压缩响应，字节计数才准确；`User-Agent` 设为 `PersonalAgent/0.1 (+personal local use)`（必须是纯 ASCII：HTTP 头不允许中文，T-13 实测 Node 会抛 `ERR_INVALID_CHAR`），不包含个人邮箱。
- Content-Type 只接受 `text/html`、`text/plain`、`text/markdown`、`application/xhtml+xml`，其余（包括缺少 Content-Type）返回 `unsupported_type`。
- 字符集：按 BOM → HTTP 头 → `<meta charset>`（前 4096 字节）→ UTF-8 的顺序确定，用 `TextDecoder` 解码；未知的字符集名退回 UTF-8，坏字节变成 U+FFFD，不抛错。Node 默认带完整 ICU，支持 `gbk` 和 `gb18030`。
- 检查目标站的 `robots.txt`：这是用户主动发起的单页抓取，只遵守 `Disallow`，不做爬取。被拒绝时返回 `robots_disallowed`，用户可以改为粘贴正文。取不到 robots.txt（404、5xx、超时）按**允许**处理；robots.txt 自身的 SSRF 拦截不吞掉。解析支持 `User-agent` 分组（命中本程序名的组优先于 `*`）、`Allow` / `Disallow` 最长匹配、`*` 通配与结尾 `# 07 知识库与长期记忆

- 版本：v1.0，2026-11-06
- 依据：原调研 `04-knowledge-and-memory.md` 中的分层原则全部保留（原始知识、会话记录、长期记忆、行动状态分开管理）。本版补充可以直接实现的参数和算法。数值都是**初始实验值**，以个人评测集的结果为准调整。

## 1. 采集流水线

```text
采集请求 → 规范化与去重 → 抓取或读入 → 写入原始 blob → 抽取正文 → 分块 → 分词 → 写入 FTS → ready
                                                                          ↘（P2）摘要作业
```

每完成一个阶段，就写入作业的 `checkpoint_json`，例如 `{"fetched":"<raw_hash>","extracted":"<text_hash>","chunked":true}`。重试时跳过已完成的阶段。摘要失败不影响资料的 `ready` 状态。

### 1.1 URL 规范化

小写 scheme 和 host；去掉默认端口和 `#fragment`；去掉 `utm_*`、`spm`、`from` 等追踪参数；其余 query 参数按键排序。规范化后的结果写入 `source_uri`，用于同一 owner 下的唯一性判断。同一个 URL 再次采集时，如果内容哈希没变，就判定为重复（`deduplicated: true`）；内容变了则生成新版本。

### 1.2 抓取（SSRF 防护，ADR-08）

- 只允许 http 和 https，端口只允许 80、443 或 URL 中显式写出的端口。
- 先做 DNS 解析，**所有**解析出的 IP 都必须是公网地址。拒绝的范围包括：`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`、`0/8`、`192.0.0/24`、`198.18/15`、文档用的测试网段、`224/3`（组播与保留）、`::`、`::1`、`fc00::/7`、`fe80::/10`、`fec0::/10`、`ff00::/8`、`2001:db8::/32`，以及 IPv4-mapped / 兼容、NAT64（`64:ff9b::/96`）、6to4（`2002::/16`）地址（按内嵌的 IPv4 判断）；`localhost`、`*.localhost`、`*.internal`、`*.local`、`metadata.google.internal` 等主机名在解析之前就拒绝。解析不了的字符串一律不放行。
- **把连接固定到已经检查过的 IP**，防止 DNS 重绑定：每一跳只解析一次，检查通过后用 Node 内置 `http/https.request` 的 `lookup` 选项把连接钉在第一个已检查的 IP 上（`Host` 头与 TLS 的 SNI / 证书校验仍用原主机名）。**与原方案不同：不引入 `undici`**，T-13 实测这样足够（S8：每跳只解析一次、`never-resolves.invalid` 这类系统 DNS 里不存在的域名也能连上，证明没有触发第二次解析）。IP 字面量（含 `2130706433`、`0x7f.1`、`[::ffff:7f00:1]` 等写法，URL 解析后统一为标准形式）直接检查，不经过 DNS。
- 手动处理重定向，最多 5 次，每次都重新执行以上检查（协议、端口、主机名、全部 IP）；端口只允许 80、443 和**原始 URL 中显式写出的端口**，重定向到别的非标准端口会被拒绝。
- 限制：响应体最大 5 MB（流式计数，超出立即中断；声明的 `Content-Length` 超限直接拒绝）；总时长 20 s（含全部重定向）；请求带 `Accept-Encoding: identity`，不接受压缩响应，字节计数才准确；`User-Agent` 设为 `PersonalAgent/0.1 (+personal local use)`（必须是纯 ASCII：HTTP 头不允许中文，T-13 实测 Node 会抛 `ERR_INVALID_CHAR`），不包含个人邮箱。
- Content-Type 只接受 `text/html`、`text/plain`、`text/markdown`、`application/xhtml+xml`，其余（包括缺少 Content-Type）返回 `unsupported_type`。
- 字符集：按 BOM → HTTP 头 → `<meta charset>`（前 4096 字节）→ UTF-8 的顺序确定，用 `TextDecoder` 解码；未知的字符集名退回 UTF-8，坏字节变成 U+FFFD，不抛错。Node 默认带完整 ICU，支持 `gbk` 和 `gb18030`。
- 检查目标站的 `robots.txt`：这是用户主动发起的单页抓取，只遵守 `Disallow`，不做爬取。。
- **测试专用开关**：进程级测试要抓取本机的测试站点时，设置 `APP_MODE=test` 且 `FETCH_ALLOW_LOOPBACK=1`，抓取策略才会把 `127.0.0.1` 当作公网；其他任何模式下该变量被忽略。默认策略下对 loopback / 私网的请求根本不会发起连接（S6 用本机监听的服务验证过连接数为 0）。
- 作业里的错误分类：`ssrf_blocked`、`unsupported_type`、`too_large`、`robots_disallowed`、`extract_failed` 和 4xx（408、429 除外）**不重试**；超时、网络错误、5xx、408、429 按退避重试（30 s、2 min，共 3 次）。作业最终失败时资料标为 `failed` 并记录错误码；已有可用版本的资料抓取失败时保持 `ready`。

### 1.3 正文抽取

- HTML：用 `linkedom` 解析，`@mozilla/readability` 提取正文，再用 `turndown` 转成 Markdown，保留标题层级、列表和表格。**已验证 T-13**：在 10 个中文页面（百科 3、文档站 4、博客 3）上检查，效果可用，不需要改用 `jsdom`；发现并修复的问题见 [T13-extraction-check](spikes/T13-extraction-check.md)。公众号转载、依赖 JS 渲染的页面、真实 GBK 站点没有真实样本。抽取前会把“只包一个标题的 `div.*heading*`”展开成标题（否则 Readability 会把维基百科等站点的小标题整体清掉）；Markdown 里**链接只留文字、图片丢弃**，且不转义 `[]*_`（这是给检索用的纯文本语料）。
- 抽取失败或正文少于 200 字时，退回到 `body.textContent`，并在 `parser_version` 后面加上 `+fallback`。
- 正文统一做 **NFC** 规范化（**不是 NFKC**：NFKC 会把全角标点 `，：（）？` 改成半角，破坏引用原文的保真度；NFKC 只用于分词和查询的归一化，见 §3.1），换行统一为 `\n`，去掉零宽字符和控制字符，压缩多余空行。正文 blob 就是这份 Markdown。
- 纯文本 / Markdown 来源：不转换，只规范化；Markdown 取 front matter 的 `title`（并从正文剥掉），没有则取第一个 `#` 标题；以 `---` 开头的 `text/plain` 响应按 Markdown 处理。标题缺省：文本取首行（≤60 字符）。
- 正文上限 50 万字符（超出返回 `too_large`，413），上传文件 ≤2 MB；两个限制谁先到谁生效——2 MB 的 ASCII 文件也会因超过 50 万字符被拒绝。
- `parser_version` 由抽取器版本和分块器版本组合而成，例如 `readability@0.6+turndown@7+chunk1`。版本号变化时，可以由作业重建（P3 提供“重建索引”按钮）。

## 2. 分块

以字符为单位而不是 token，这样结果是确定的，也不依赖分词器：

| 参数 | 值 |
|---|---|
| 目标长度 | 600 字符 |
| 上限 | 900 字符 |
| 下限 | 120 字符（短于此的块与相邻块合并） |
| 重叠 | 80 字符（只在同一节内部的块之间重叠） |
| 切分优先级 | Markdown 标题 → 空行（段落）→ 句末标点 `。！？；.!?` → 硬切 |

- 每个块记录 `heading_path`（如“二、方法 > 复习间隔”）以及在正文中的 `[char_start, char_end)`。
- 表格和代码块尽量保持完整；超过上限时按行切开，并给每个分块重复表头。
- `token_estimate = ceil(中文字符数 × 0.7 + 其他字符数 / 4)`，只用于控制上下文预算。

## 3. 检索

### 3.1 分词（入库和查询共用一个函数）

```ts
const seg = new Intl.Segmenter("zh", { granularity: "word" });
function segment(text: string): string[] {
  return [...seg.segment(text.normalize("NFKC").toLowerCase())]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment)
    .filter((t) => !STOPWORDS.has(t));   // 的 了 是 在 和 与 及 一个 我们 …（约 50 个，单独维护）
}
```

- 写入 FTS 时：`seg_text = segment(chunk.text).join(" ")`，`heading_seg = segment(heading_path).join(" ")`。
- 英文单词由 Segmenter 按词切分，再经过 `unicode61` 处理，大小写不敏感。

### 3.2 查询

```text
q → tokens = segment(q)
词法路：  SELECT rowid, bm25(app_chunks_fts, 1.0, 2.0) AS s FROM app_chunks_fts
          WHERE app_chunks_fts MATCH '"t1" OR "t2" OR …' ORDER BY s LIMIT 20
子串路：  只在 q 中存在 ≥3 字符的连续片段时执行
          MATCH '"片段1" OR "片段2"'（取最长的 3 个片段），LIMIT 20
融合：    RRF，score = Σ 1/(60 + rank)
过滤：    JOIN app_chunks WHERE owner_id=? AND active=1 [AND document 标签匹配]
去冗余：  同一个版本中相邻（ordinal 相差 1）的命中合并成一个结果
输出：    top_k（默认 6，最多 10），工具输出总长度 ≤ 6,000 字符，超出时截断末尾的结果
```

- 一个词也没有（例如全是停用词）时，返回空结果，并在工具输出中提示“请换个说法”。
- 过滤条件在查询时执行，引用校验时**再执行一次**。

### 3.3 Embedding 的触发条件（ADR-06）

只定义接口，不实现：

```ts
interface Embedder { model: string; dims: number; embed(texts: string[]): Promise<Float32Array[]> }
interface VectorIndex { upsert(chunkId: number, v: Float32Array): Promise<void>; search(v: Float32Array, k: number): Promise<{ chunkId: number; score: number }[]> }
```

评测结果 Recall@10 < 90%，或同义改写类问题的召回率 < 70% 时启动接入。规模在 1 万个片段以内时，`VectorIndex` 先用 JS 暴力计算余弦相似度（向量以 BLOB 存放），不需要 SQLite 扩展。

## 4. 带引用的回答

### 4.1 流程

1. 模型调用 `kb_search`，得到 `<source id="chunk:N">` 片段（ADR-05，片段写入 transcript）。
2. 模型回答，正文中用 `[n]` 标注，末尾输出 `<citations>` 块（05 §4.1）。
3. 服务端把助手条目转换成 `AppEntry` 时，解析引用并逐条校验：
   - **存在**：`chunk_id` 存在，属于当前 owner；
   - **有效**：所在资料不是 `revoked` 或 `purged`，片段 `active=1`；
   - **来自这次 run**：这个 `chunk_id` 出现在**同一次 run** 的某个 `kb_search` 或 `kb_get_source` 工具结果中。这样能挡住模型凭空写出、恰好存在的片段 ID。
4. 校验不通过的引用 `valid=false`，前端标红。正文中出现了 `[n]` 却没有对应条目的，同样标红。

引用校验只能证明“引用的东西真实存在、而且模型确实看过”，不能证明它支持那句话。语义上是否支持，由评测时人工判定（见 08 §5）。

### 4.2 资料不足

系统提示要求模型直接说明资料不足。评测集中专门放 10 道“资料里没有答案”的题，要求至少 9 道被正确判定为不足。

## 5. 长期记忆（P2）

### 5.1 数据契约

见 04 的 `app_memories`。补充约定：

- **kind**：`preference`（偏好，例如 `review.verbosity`）、`profile_fact`（关于用户的事实，例如 `work.role`）、`project_context`（项目背景，例如 `project.blog.stack`）。
- **key**：小写字母、数字、`.`、`_`，按“领域.属性”命名。同一个作用域内，一个 key 只能有一条已确认的记忆。模型给出的 key 由服务端规范化（去空格、转小写）；要查已有的 key，可以先调用 `memory_search`。
- **scope**：`global` 或 `project:<名称>`。只有 `global` 会进入 profile section；项目相关的记忆要通过 `memory_search` 获取。
- **value**：自然语言，不超过 200 字。

### 5.2 写入路径

| 路径 | 状态 | 说明 |
|---|---|---|
| 对话中明确说“记住” → `memory_remember` | confirmed | 同一个 key 已有记忆时，旧记录标为 `superseded` |
| 记忆页手动添加 | confirmed | — |
| 后台提取 | candidate | 用户确认后才会生效 |

每次写入都会生成一条 `app_memory_revisions` 记录，同时 `memory_set_revision` 加一。

### 5.3 使用

- 全局偏好：profile section（05 §4.2），最多 20 条。
- 其他记忆：`memory_search` 对 `value` 和 `key` 做分词匹配。记忆通常只有几百条，直接在内存中打分即可；结果带 `memory_id@revision`，所以 transcript 中能看出这次回答用了哪些记忆。

### 5.4 候选提取（FR-MEM-04）

- 触发：会话空闲 10 分钟，并且自上次提取后新增了至少 4 条用户消息。每个会话的提取进度（截至哪个条目）保存在 `app_settings` 中，键为 `extract_cursor:<conv>`。
- 执行：作业 `extract_memory`，走后台会话（ADR-10）。输入只包含新增的用户消息和助手回答的文本，不包含工具结果，避免把资料内容误当成用户事实。
- 过滤：schema 校验 → 与 suppression 表比对 → 与现有的 confirmed 记忆比较，值相同的丢弃 → 命中敏感类别（健康、财务、政治宗教、他人的私人信息）的丢弃。敏感判断由提示词约束，再加一份关键词表兜底。
- 防止删除的记忆被写回来：作业提交前，在同一个事务中再查一次 suppression 表，然后才写入 candidate。

## 6. 删除与遗忘

| 操作 | 立即生效 | 异步执行 | 不能保证 |
|---|---|---|---|
| 资料“停止使用” | 片段 `active=0`；检索和引用校验都不再返回 | — | — |
| 资料“彻底删除” | 同上，状态改为 `purging` | 删除 blob（没有其他版本引用时）、清空片段文本、删除 FTS 行、清空摘要，状态改为 `purged` | 见下 |
| 记忆“停用” | 不再进入 section 和检索 | — | — |
| 记忆“删除” | 删除这一行和它的 revisions，写入 suppression | — | 见下 |

**无法删除的副本，界面上要明确说明：**

1. **对话记录。** 模型曾经看到过的片段，作为工具结果保存在 Pi 的 transcript 和压缩摘要里。Pi 1.5.0 没有经过验证的、按条目删除的接口，应用也不能直接修改 `pi_*` 表。MVP 的做法是：资料详情页列出“引用过这份资料的会话”，用户可以把这些会话归档，归档后不再继续使用。**物理清除会话的方案，在 P3 评估 Pi 是否提供删除会话的能力之后再定**，在那之前只承诺逻辑遗忘。
2. **备份。** 最多保留 7 天。每次彻底删除都追加一条记录到 `data/purge-log.jsonl`，这个文件**不随数据库一起恢复**。恢复备份后，重新执行备份时间点之后的删除记录。
3. **模型供应商。** 已经发送给 DeepSeek 的内容，受对方的数据政策约束。

## 7. 评测集

### 7.1 检索评测（零费用，可以随时运行）

`tests/retrieval/eval.jsonl`，每行一题：

```json
{"id":"q01","type":"answerable","query":"间隔重复的复习间隔应该怎么安排","relevant":[{"doc":"spaced-repetition","contains":"逐步拉长"}],"tags":["同义"]}
{"id":"q31","type":"unanswerable","query":"我收藏的文章里有没有讲番茄钟的"}
{"id":"q41","type":"versioned","query":"…","relevant":[{"doc":"…","version":"v2","contains":"…"}]}
```

- 题目构成：30 道有答案（其中至少 6 道是两字词问题、6 道是同义改写），10 道没有答案，10 道考查版本或冲突。语料使用 20–50 篇用户授权的资料。
- 判定：`relevant` 用“资料 + 包含的文本”来指定，而不是片段 ID，这样调整分块参数后评测集仍然可以用。
- 指标：Recall@10、MRR，以及按标签分组的召回率。
- 运行：`pnpm eval:retrieval`，输出 `tests/retrieval/reports/<日期>.md`。

### 7.2 回答评测（付费，每次运行都需要用户批准）

用同样的 50 道题，通过真实的 DeepSeek 回答。自动统计：引用定位有效率、“资料不足”的判定准确率、该检索时没有检索的比例。人工抽查 20 道，判断引用在语义上是否支持陈述。运行前先报告预计的 token 数和费用，用户确认后才开始。
