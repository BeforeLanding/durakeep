# durakeep

durakeep 是一个在本机运行的单用户知识库和日常助理。你可以收藏网页和笔记、对资料提问并查看引用原文、管理长期记忆，以及设置一次性提醒。对话和工具执行由 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 驱动，进程重启后可以恢复未完成的工作。

## 快速体验

建议使用 Node.js 24 和 pnpm 11.7.0。在终端运行：

```bash
git clone https://github.com/BeforeLanding/durakeep.git
cd durakeep
pnpm install --frozen-lockfile
pnpm demo
```

打开 [http://127.0.0.1:4777](http://127.0.0.1:4777)，用口令 `demodemo` 登录。在资料页确认样例索引完成后，新建对话并问「间隔重复应该如何安排复习？」，将鼠标移到引用编号上查看原文。演示使用脚本化模拟模型和临时数据目录，无需 API Key，也不会产生模型费用。

## 当前功能

- **资料与引用问答**：收藏网页、粘贴文本，或上传 UTF-8 Markdown / 文本文件。资料后台索引，结合 SQLite FTS5 与子串检索。回答可追溯到原文片段，失效引用会在界面标出。
- **对话与任务**：流式显示回答，支持插话、停止、失败后继续。任务页可查看采集与索引进度、重试和取消作业。
- **资料管理**：查看版本、编辑摘要、停止或恢复检索、彻底删除资料。已登录用户可通过 `GET /v1/export` 导出资料及版本为 ZIP。
- **长期记忆**：查看、编辑、确认或拒绝从空闲对话提取的候选记忆。已确认的偏好可用于后续对话。
- **一次性提醒**：在对话或提醒页创建提醒，按账户时区安排，到点后在 Web 界面接收通知。

P0–P2 的开发任务已完成，P3 的备份恢复与运维收尾仍在计划中。各项验收记录见 [任务看板](docs/TASKS.md)和[开发进度](docs/PROGRESS.md)。

## 使用自己的资料

安装依赖后，先初始化账户，再构建前端：

```bash
pnpm cli init --timezone=Asia/Shanghai
pnpm web:build
```

在启动服务的终端中设置环境变量 `DEEPSEEK_API_KEY`，然后运行 `pnpm dev`。用初始化时设置的口令登录 [本机 Web 界面](http://127.0.0.1:4777)。默认模型为 `deepseek-flash`，可通过 `CHAT_MODEL` 指定。使用真实模型会产生 API 费用，对话及用于回答或生成摘要的资料内容可能发送给 DeepSeek。

服务仅监听 `127.0.0.1`，默认端口为 `4777`。数据默认写入仓库下的 `data/`，可用 `DATA_DIR` 指定其他目录。初始化账户和启动服务须使用同一个数据目录。

## 持久性与删除边界

- 进程崩溃后，已接纳的输入和已提交的业务写入可恢复。未完成的回答会按重试策略继续或明确失败，已提交的写操作通过幂等记录避免重复生效。
- 流式回答尚未持久化的尾部文字在崩溃后可能消失。断电或宿主故障时，SQLite 的 `synchronous=NORMAL` 设置允许最近的提交丢失。
- 彻底删除资料会立即停止检索，并在后台清理原文、片段和摘要。已经进入历史对话、备份、导出文件或模型供应商系统的副本需要分别处理。详见[删除与遗忘](docs/07-knowledge-memory.md#6-删除与遗忘)。

## 开发与设计

技术栈为 TypeScript、Hono、React + Vite、SQLite 和 pi-durable 1.5.0。开发前端时可运行 `pnpm web:dev`，由 Vite 将 API 请求代理到本机服务。

```bash
pnpm lint
pnpm test
pnpm test:recovery
```

测试使用模拟模型。产品与技术细节见 [产品需求](docs/02-prd.md)、[系统架构](docs/03-architecture.md)、[运行时接入](docs/05-runtime-integration.md)、[HTTP API](docs/06-api.md)、[知识库与长期记忆](docs/07-knowledge-memory.md)、[测试计划](docs/08-test-plan.md)和[架构决策](docs/DECISIONS.md)。内核验证结果见 [P0 报告](docs/spikes/P0-REPORT.md)，原始调研和资料快照见[调研归档](docs/research/baseline-2026-11-06/README.md)。
