import { expect, test } from "vitest";
import { startDemo } from "../support/demo.ts";

type Answer = { type: string; text?: string; citations?: { n: number; valid: boolean; chunk_id: number }[] };

test("演示 faux 通过真实业务工具处理收藏、引用、拒答、偏好和提醒", async () => {
  const demo = await startDemo();
  try {
    const login = await fetch(`${demo.url}/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "demodemo" }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^sid=/);
    async function request<T>(path: string, init?: unknown, status = 200): Promise<T> {
      const res = await fetch(`${demo.url}${path}`, {
        headers: { Cookie: cookie!, "Content-Type": "application/json" },
        ...(init === undefined ? {} : { method: "POST", body: JSON.stringify(init) }),
      });
      expect(res.status, path).toBe(status);
      return await res.json() as T;
    }
    const { items: seeds } = await request<{ items: { status: string }[] }>("/v1/documents");
    expect(seeds.map((d) => d.status)).toEqual(["ready", "ready", "ready"]);
    expect(demo.output()).toContain("公开演示口令：demodemo");
    expect(demo.output()).toContain("试试：明天晚上八点提醒我复习间隔重复");
    const conv = await request<{ id: string }>("/v1/conversations", {}, 201);
    const lastAnswer = async () => {
      const { entries } = await request<{ entries: Answer[] }>(`/v1/conversations/${conv.id}/entries`);
      return entries.findLast((e) => e.type === "assistant");
    };
    async function ask(text: string, reply: RegExp) {
      await request(`/v1/conversations/${conv.id}/messages`, { text, client_request_id: crypto.randomUUID() }, 202);
      await expect.poll(async () => (await lastAnswer())?.text, { timeout: 10_000 }).toMatch(reply);
      return (await lastAnswer())!;
    }
    const captureText = "把本周的阅读笔记写成一页，周五回顾。";
    const capture = await ask(`保存这段：${captureText}`, /已收藏这段文字.*document_id.*状态/);
    const documentId = /document_id）：([a-f\d-]{36})/.exec(capture.text!)?.[1];
    expect(documentId).toBeDefined();
    await expect.poll(async () => (await request<{ status: string }>(`/v1/documents/${documentId}`)).status).toBe("ready");

    const sourced = await ask("间隔重复应该如何安排复习？", /即将遗忘.*\[1\]/);
    expect(sourced.citations).toEqual([expect.objectContaining({ n: 1, valid: true })]);
    const source = await request<{ text: string }>(`/v1/chunks/${sourced.citations![0]!.chunk_id}`);
    expect(source.text).toContain("间隔重复");
    const empty = await ask("qzxwv9876nothere", /^现有资料不足/);
    expect(empty.citations ?? []).toEqual([]);

    await ask("记住我喜欢简短总结", /已记住「我喜欢简短总结」。作用范围：全局/);
    const memories = await request<{ items: unknown[] }>("/v1/memories?status=confirmed");
    expect(memories.items).toContainEqual(expect.objectContaining({ value: "我喜欢简短总结", scope: "global", kind: "preference" }));
    await ask("明天晚上八点提醒我复习间隔重复", /已创建提醒「复习间隔重复」：\d{4}-\d{2}-\d{2} 20:00 星期[日一二三四五六]（Asia\/Shanghai）/);
    const before = Date.now();
    await ask("10 分钟后提醒我喝水", /已创建提醒「喝水」.*星期[日一二三四五六]（Asia\/Shanghai）/);
    const { items: reminders } = await request<{ items: { text: string; local: string; timezone: string; next_fire_at: number }[] }>("/v1/reminders");
    expect(reminders).toContainEqual(expect.objectContaining({ text: "复习间隔重复", local: expect.stringContaining("20:00"), timezone: "Asia/Shanghai" }));
    const relative = reminders.find((r) => r.text === "喝水")!;
    expect(relative.next_fire_at).toBeGreaterThan(before + 9 * 60_000);
    expect(relative.next_fire_at).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(demo.output()).not.toContain(captureText);
  } finally {
    await demo.stop();
  }
});
