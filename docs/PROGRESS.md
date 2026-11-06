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

---

## 2026-11-06 开发前文档 v1

- 改动：基于基础调研完成修订调研、PRD、架构、数据模型、Pi 接入规格、API、知识与记忆、测试计划、实施计划、ADR、来源索引、AGENTS.md。
- 测试：只做了本机无费用验证（Node 24.16.0 / SQLite 3.53.0 FTS5+trigram / Intl.Segmenter 中文分词 / pi-ai 与 chord 1.5.0 tarball 完整性）。未安装依赖，未调用模型。
- 偏离原调研：见 [01 §8](01-research.md#8-相对原调研的修订清单)。
