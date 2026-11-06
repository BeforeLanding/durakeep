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

---

## 2026-11-06 开发前文档 v1

- 改动：基于基础调研完成修订调研、PRD、架构、数据模型、Pi 接入规格、API、知识与记忆、测试计划、实施计划、ADR、来源索引、AGENTS.md。
- 测试：只做了本机无费用验证（Node 24.16.0 / SQLite 3.53.0 FTS5+trigram / Intl.Segmenter 中文分词 / pi-ai 与 chord 1.5.0 tarball 完整性）。未安装依赖，未调用模型。
- 偏离原调研：见 [01 §8](01-research.md#8-相对原调研的修订清单)。
