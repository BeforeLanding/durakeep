# P0 内核验证报告

> 状态：**进行中**。T-06 收尾时补全 K1–K7 与 ADR 结论；下面只记录已完成任务的实测结果。

## T-01 · SIGKILL 在 Windows 上的语义（08 §3 的前置确认）

环境：Windows 11、Node 24.16.0。测试：`tests/int/sigkill.test.ts`（子进程 `tests/support/sigkill-child.ts` 注册 `exit`、`beforeExit`、`SIGTERM`、`SIGINT`、`SIGHUP`、`SIGBREAK` 钩子，并每 5 ms 写一行 tick）。

| 方式 | 结果 |
|---|---|
| 外部 `process.kill(child.pid, "SIGKILL")` | 子进程约 5 ms 内退出；**没有任何钩子执行**；之后不再有 tick 写入。 |
| 自杀 `process.kill(process.pid, "SIGKILL")` | 下一条语句不执行；没有钩子执行。 |
| 子进程 `exit` 事件 | `code=1, signal=null`（不是 `signal="SIGKILL"`）。 |

结论：**可用于故障注入**（立即终止、不执行退出钩子）。注意：Windows 上无法靠 `signal === "SIGKILL"` 判断是被杀，驱动用“没有 RESULT 输出且退出码非 0”判断。运行 3 轮（每轮 2 条），全部通过。
