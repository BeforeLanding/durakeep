// T-11：R1 ×20（HTTP 层）：服务在 ingress.after_submit 被杀 → 重启（恢复扫描）→ 客户端重发同一个 client_request_id。
// 以及 ingress.after_insert：已持久化、尚未交给 Pi 时被杀，重启后由恢复扫描派发，不丢失。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { guardDb } from "../../packages/db/src/index.ts";
import { openAppDatabase, PiRuntime, startPi, demoFaux } from "../../packages/runtime-pi/src/index.ts";
import { freePort, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";

const REPEAT = Number(process.env.REPEAT ?? 20);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));

/** 服务已停止后，在同一个数据库上用 faux 恢复并数出该会话的用户 / 助手条目。 */
async function inspect(dataDir: string, convId: string, submissionId: string) {
  const raw = await openAppDatabase(join(dataDir, "app.sqlite"));
  const db = guardDb(raw);
  const row = await db.get<{ pi_conversation_id: string }>("SELECT pi_conversation_id FROM app_conversations WHERE id = ?", convId);
  const pi = await startPi({ mode: "test", db: raw, faux: demoFaux() });
  const rt = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  try {
    rt.resume();
    const settled = await rt.waitSubmission(submissionId);
    let last: Parameters<Parameters<PiRuntime["observe"]>[2]>[0] | undefined;
    const obs = await rt.observe(row!.pi_conversation_id, undefined, (s) => (last = s));
    await obs.stop();
    const entries = last!.entries;
    const ingress = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_ingress_events"))?.c;
    return {
      settled,
      users: entries.filter((e) => e.kind === "user").length,
      assistants: entries.filter((e) => e.kind === "assistant").length,
      ingress,
    };
  } finally {
    await rt.close();
  }
}

test(`R1 × ${REPEAT}：Pi 已接纳、HTTP 响应丢失（服务被杀）→ 重启 → 客户端重发 → 只有一个 submission、一条用户消息`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("t11-r1");
    let s1: Server | undefined;
    let s2: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      s1 = await startServer(dir, port, { FAULT_POINT: "ingress.after_submit" });
      const cookie = await loginCookie(s1.base);
      const created = (await (await post(s1.base, "/v1/conversations", cookie, {})).json()) as { id: string };
      const crid = crypto.randomUUID();
      const sent = await post(s1.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "请回答" }).then(
        (r) => r.status,
        () => "连接断开",
      );
      const code = await s1.exited;
      if (sent !== "连接断开" || code === 0) failures.push(`#${i} 服务没有在 after_submit 被杀：sent=${sent} code=${code}`);

      s2 = await startServer(dir, port); // 恢复扫描会重新派发 accepted 的记录
      const again = await post(s2.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "请回答" });
      const body = (await again.json()) as { status: string; deduplicated: boolean; submission_id: string };
      if (again.status !== 200 || body.status !== "dispatched" || !body.deduplicated) failures.push(`#${i} 重发：${again.status} ${JSON.stringify(body)}`);
      await s2.stop();

      const r = await inspect(dir, created.id, body.submission_id);
      if (r.settled.status !== "done" || r.users !== 1 || r.assistants !== 1 || r.ingress !== 1) {
        failures.push(`#${i} 状态：${JSON.stringify({ settled: r.settled, users: r.users, assistants: r.assistants, ingress: r.ingress })}`);
      }
    } finally {
      await s1?.stop();
      await s2?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 900_000);

test(`ingress.after_insert × ${REPEAT}：已持久化、尚未交给 Pi 时被杀 → 重启由恢复扫描派发 → 重发得到同一结果，不丢失`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("t11-ins");
    let s1: Server | undefined;
    let s2: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      s1 = await startServer(dir, port, { FAULT_POINT: "ingress.after_insert" });
      const cookie = await loginCookie(s1.base);
      const created = (await (await post(s1.base, "/v1/conversations", cookie, {})).json()) as { id: string };
      const crid = crypto.randomUUID();
      const sent = await post(s1.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "不要丢" }).then(
        (r) => r.status,
        () => "连接断开",
      );
      await s1.exited;
      if (sent !== "连接断开") failures.push(`#${i} 没有被杀：${sent}`);

      s2 = await startServer(dir, port);
      const again = await post(s2.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "不要丢" });
      const body = (await again.json()) as { status: string; deduplicated: boolean; submission_id: string };
      // 记录是被杀之前持久化的 → 重发是 deduplicated；是否已被恢复扫描派发都应当是 dispatched
      if (again.status !== 200 || !body.deduplicated || body.status !== "dispatched") failures.push(`#${i} 重发：${again.status} ${JSON.stringify(body)}`);
      await s2.stop();
      const r = await inspect(dir, created.id, body.submission_id);
      if (r.settled.status !== "done" || r.users !== 1 || r.assistants !== 1) failures.push(`#${i} 状态：${JSON.stringify({ settled: r.settled, users: r.users, assistants: r.assistants })}`);
    } finally {
      await s1?.stop();
      await s2?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 900_000);
