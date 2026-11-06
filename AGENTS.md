# AGENTS.md

给在本仓库工作的编码 agent（Claude Code、Codex 等）的约定。与 `docs/` 冲突时，以 `docs/DECISIONS.md` 和 `docs/05-runtime-integration.md` 为准，并提出修订。

## 项目一句话

单用户个人知识与日常助理。pi-durable 1.5.0 负责对话与工具的持久执行；资料、记忆、提醒、作业是应用自有的业务表。设计全在 `docs/`。

## 硬规则

1. **不得产生付费模型调用。** 测试、演示、调试一律使用 faux provider。`APP_MODE=test|demo` 下构造真实 provider 必须抛错。开发者的系统环境变量里往往已经设有 `DEEPSEEK_API_KEY`，所以“项目没配 key 就安全”不成立。需要真实模型（`pnpm eval:answer` 或手动对话）时，**停下来请用户批准**，并报告预计 token 与费用；批准仅对那一次有效。
2. **只有 `packages/runtime-pi` 可以 import `@earendil-works/*`。** 业务包不依赖 `runtime-pi`。由 lint 规则强制。
3. **业务代码不读写 `pi_*` 表**，只通过 `RuntimePort`。
4. **所有业务查询带 `owner_id`。** 工具从会话映射取 owner，不接受参数里的 owner。
5. **写工具必须走 `operations.once()` 并声明 `replay: "safe"`**（ADR-04）。新增写工具需在 05 §5 的工具目录登记。
6. **`db.transaction(cb)` 回调里只用传入的事务句柄**，不得再调用外层 `db`（会永久挂起）。
7. **依赖精确锁定**，不加 `^`/`~`；升级 `@earendil-works/*` 需要单独任务和升级测试。
8. **不给模型 shell / 文件 / 任意网络能力**（ADR-08）；不安装 `CodingTools`。
9. **日志只记 ID 与状态**，不记消息正文、资料正文、口令或 key。
10. **section 渲染必须确定**：不放时间戳、随机数或会话内变化的数据（ADR-05、ADR-09）。

## 命令（T-00 后可用）

```bash
pnpm install
pnpm dev                 # server + web，APP_MODE=dev，读取 DEEPSEEK_API_KEY
pnpm demo                # faux 模型 + 样例数据，零费用
pnpm test                # unit + int（零费用）
pnpm test:recovery       # 子进程故障注入
pnpm eval:retrieval      # 检索评测（零费用）
pnpm eval:answer --dry-run   # 付费评测预估；正式运行需用户批准
pnpm lint
pnpm cli init
```

## 工作方式

- 每次只做 `docs/TASKS.md` 里的一张卡；完成后在 `docs/PROGRESS.md` 追加：改了什么、跑了哪些测试及结果、意外。
- DoD 里的测试必须实际运行通过；没跑的明确写“未运行”。
- 需要改 ADR、任务超估算 2 倍、需要用户数据或付费调用时：停下，交回。
- 文档与实现不一致时，同一提交里修正文档；不要让 `docs/` 过期。
- 不为“下一个边界缺口”自动开新工作项；登记到 PROGRESS 的“已知缺口”，等用户决定。

## 代码风格

- TypeScript strict，`erasableSyntaxOnly`（不用 enum / namespace / 参数属性），ESM。
- 错误：业务错误抛 `AppError(code, userMessage)`；`code` 为 snake_case，列在 06 §1。
- 时间：内部一律 UTC 毫秒 + IANA 时区字符串；只在展示层格式化。
- ID：UUIDv7（`core/id.ts`），片段除外。
- 测试与实现同包：`src/foo.ts` ↔ `src/foo.test.ts`；跨包场景放 `tests/`。

## 提交

- Conventional Commits（`feat:`、`fix:`、`test:`、`docs:`）。
- 推送到远端、发布、公开仓库前征得用户同意。
