# 进度记录

每完成一张任务卡追加一条。格式：

```text
## YYYY-MM-DD T-xx 名称
- 改动：
- 测试：命令 → 结果（未运行的写“未运行”）
- 意外 / 偏离设计：
- 对文档的修改：
```

## 已知缺口

（登记发现但未处理的问题，等用户决定是否开新任务。）

## 2026-11-06 T-00 仓库骨架
- 改动：pnpm workspace（packages/core、db、runtime-pi，apps/server 占位）；tsconfig（strict、erasableSyntaxOnly、nodenext）；vitest 三个 project（unit / int / recovery）；eslint 10 + dependency-cruiser 规则（ADR-01 两条：仅 runtime-pi 可 import @earendil-works/*、业务包不依赖 runtime-pi）；.nvmrc、engines、CI（ubuntu/windows × Node 22.19.0/24）；测试 setup 强制 APP_MODE=test 并清除 *_API_KEY 环境变量。依赖全部精确版本；@earendil-works/* 四个包 1.5.0 仅在 runtime-pi。
- 测试：pnpm test → 3 passed（空测试 + 依赖规则违规时失败 + 当前仓库通过）；pnpm lint → 通过（depcruise、eslint、tsc）；pnpm test:recovery → 无用例（passWithNoTests）。CI 工作流未在远端运行。
- 意外 / 偏离设计：pnpm 11 把未决的依赖构建脚本当作错误，会让每次 pnpm run 失败；已在 pnpm-workspace.yaml 的 allowBuilds 把 @google/genai、protobufjs 显式设为 false（不执行任何第三方脚本）。TypeScript 取 6.0.3（typescript-eslint 8.72.1 不支持 TS 7）。依赖规则的 fixture 在无 node_modules 的目录里跑，runtime-pi 样例会多报 no-unresolvable，测试只断言 ADR-01 两条规则。“APP_MODE=test 构造真实 provider 必须抛错”的保护留到 T-01（需要 pi-ai API），此处仅在测试进程清除 key。
- 对文档的修改：无。

## 2026-11-06 T-01 Pi 最小链路与故障注入框架
- 改动：core/fault.ts、core/mode.ts；runtime-pi 的 start.ts（faux + SQLite，Pi 表前缀 pi_）与 provider.ts（**付费保护**：APP_MODE 非 dev/prod 时 createRealProvider 抛 PaidProviderForbidden，且先检查后 import，真实供应商模块不会被加载；未知 APP_MODE 按 test 处理）；子进程场景 runtime-pi/src/testing/child-chat.ts 与驱动 tests/support/driver.ts；SIGKILL 语义测试；docs/spikes/P0-REPORT.md（先写入 SIGKILL 一节，T-06 补全）。
- 测试：pnpm test → 6 文件 12 用例通过（含：fault 单测、provider 守卫单测、faux+SQLite 无故障链路、工具内 SIGKILL 后重启——user 条目已提交、run 继续完成、replay:safe 工具重跑一次共执行 2 次、模型仅再请求 1 次）；SIGKILL 语义测试额外单独跑 3 轮全过；pnpm lint 通过。未调用任何真实模型。
- 意外 / 偏离设计：①Windows 上被 SIGKILL 的子进程 exit 事件是 code=1、signal=null，驱动不能依赖 signal；终止延迟约 5 ms，退出钩子不执行（符合要求）。②faux 的 fauxAssistantMessage 默认 stopReason 为 "stop"，带工具调用必须传 { stopReason: "toolUse" }，否则工具不会执行、被当作最终回答。③故障场景此时只覆盖“工具内被杀”，其余故障点随各任务加入。
- 对文档的修改：05 §10 的 faux 示例加 stopReason: "toolUse"；08 §3 注明 Windows 实测的 exit 事件形态。

## 2026-11-06 T-02 共享数据库验证（ADR-02）
- 改动：packages/db（结构性接口 SqlDatabase、迁移 app_migrations / app_probe）；runtime-pi/src/testing/faux.ts（测试再导出 faux，避免测试直接 import @earendil-works）；tests/int/shared-db.test.ts。
- 测试：K1（同文件 pi_/app_ 表并存；提交、关闭、重开后 Pi 根会话与条目、业务行都在；同 requestId 找回同一 submission；faux 仅被调用 1 次）→ 通过。K2（10 个会话并发共 1000 次 Pi run + 1000 个多语句业务事务交错）→ 通过：无死锁、错误 0、无 ReadAfterWrite、callCount=1000、业务行=1000，单轮约 1.1 s。K1/K2 共运行 6 轮（含 1 轮 verbose），全部通过；pnpm test 全量 15 用例通过，pnpm lint 通过。
- 意外 / 偏离设计：任务卡写“packages/db 打开 NodeSqliteDatabase”，但它来自 chord，违反 ADR-01（只有 runtime-pi 可 import）。改为 runtime-pi 打开连接，db 包只依赖结构性接口 SqlDatabase（NodeSqliteDatabase 结构上兼容，已通过类型检查）。这不改变 ADR-02 的决策本身。K2 的 Pi run 是顺序提交于各自会话、会话间并发；没有覆盖 submit(tx, draft) 的 ReadAfterWrite 路径（业务代码不用它）。
- 对文档的修改：03 §2 目录说明、09 T-02 产出、05 §2 注释（已验证 T-02）。ADR-02 仍待 K3（T-05）后才改状态。

## 2026-11-06 T-03 section 与 write 语义验证（ADR-05）
- 改动：runtime-pi/src/testing/section-spike.ts（异步 section 读取 app_ 表）、testing/docs.ts；startPi 增加 extensionsFactory（扩展需要共享连接）；tests/int/section-write.test.ts。
- 测试：K5 → 通过：异步 render 读宿主表可行；10 次请求后 pi.system=1，section 渲染 10 次；改偏好后恰好 +1（共 2），再请求不再追加。K6（只记录）→ 带 requestId 的 write 去重：同 id 重复提交返回同一 submission，内容不同时以第一次为准，会话忙时与重启后重投均成立。共 3 个用例，运行 6 轮全过；pnpm test 全量 18 用例通过，pnpm lint 通过。无真实模型调用。
- 意外 / 偏离设计：render 每次请求都会执行（不是仅在变化时），所以 profile 必须按 memory_set_revision 缓存，否则每次请求都查库。K5 只验证了“文本不变则不追加”，没有验证 prompt cache 的实际命中（faux 没有缓存）。
- 对文档的修改：05 §4.2（K5 结论与缓存要求）、05 §6（K6 结论，去掉“先查 transcript”的备选）。DECISIONS 的 ADR-05 状态按任务卡留到 T-06 统一更新。

---

## 2026-11-06 开发前文档 v1

- 改动：基于基础调研完成修订调研、PRD、架构、数据模型、Pi 接入规格、API、知识与记忆、测试计划、实施计划、ADR、来源索引、AGENTS.md。
- 测试：只做了本机无费用验证（Node 24.16.0 / SQLite 3.53.0 FTS5+trigram / Intl.Segmenter 中文分词 / pi-ai 与 chord 1.5.0 tarball 完整性）。未安装依赖，未调用模型。
- 偏离原调研：见 [01 §8](01-research.md#8-相对原调研的修订清单)。
