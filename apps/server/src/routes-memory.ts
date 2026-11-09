import { AppError, type Json } from "@durakeep/core";
import { onceStrict, type SqlDatabase } from "@durakeep/db";
import type { MemoryRow, MemoryService } from "@durakeep/memory";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { readJson } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const presentMemory = (m: MemoryRow) => ({
  id: m.id,
  kind: m.kind,
  key: m.key,
  value: m.value,
  scope: m.scope,
  status: m.status,
  revision: m.revision,
  source: m.source,
  supersedes_id: m.supersedesId,
  confirmed_at: m.confirmedAt,
  created_at: m.createdAt,
  updated_at: m.updatedAt,
});

/** 记忆接口（06 §5）。 */
export function mountMemoryRoutes(app: Hono<AppEnv>, deps: { db: SqlDatabase }, memory: MemoryService) {
  app.get("/v1/memories", async (c) => {
    const rows = await memory.list(c.get("owner").id, { status: c.req.query("status") });
    return c.json({ items: rows.map(presentMemory), next_cursor: null });
  });

  // 手动添加：直接保存为 confirmed；client_request_id 做请求级幂等
  app.post("/v1/memories", async (c) => {
    const owner = c.get("owner");
    const body = (await readJson(c)) as Record<string, unknown> | null;
    const crid = body?.client_request_id;
    if (typeof crid !== "string" || !UUID.test(crid)) throw new AppError("invalid_request", "client_request_id 必须是 UUID", { issues: [{ path: "client_request_id" }] });
    const args = { kind: body?.kind, key: body?.key, value: body?.value, scope: body?.scope ?? "global" };
    for (const f of ["kind", "key", "value", "scope"] as const) {
      if (typeof args[f] !== "string") throw new AppError("invalid_request", `${f} 必须是字符串`, { issues: [{ path: f }] });
    }
    const r = await onceStrict(deps.db, owner.id, `http:memory:${crid}`, "memory_create", { kind: args.kind as string, key: args.key as string, value: args.value as string, scope: args.scope as string } satisfies Json, async (tx) => {
      const res = await memory.rememberTx(tx, owner.id, { kind: args.kind as string, key: args.key as string, value: args.value as string, scope: args.scope as string, source: { kind: "manual" }, changedBy: "user" });
      return { memory_id: res.memoryId } satisfies Json;
    });
    const m = await memory.get(owner.id, (r.result as { memory_id: string }).memory_id);
    return c.json(presentMemory(m), r.deduplicated ? 200 : 201);
  });

  app.patch("/v1/memories/:id", async (c) => {
    const body = (await readJson(c)) as { value?: unknown; scope?: unknown; expected_revision?: unknown } | null;
    return c.json(presentMemory(await memory.update(c.get("owner").id, c.req.param("id"), body ?? {})));
  });
  app.post("/v1/memories/:id/confirm", async (c) => c.json(presentMemory(await memory.confirm(c.get("owner").id, c.req.param("id")))));
  app.post("/v1/memories/:id/reject", async (c) => c.json(presentMemory(await memory.reject(c.get("owner").id, c.req.param("id")))));
  app.post("/v1/memories/:id/revoke", async (c) => c.json(presentMemory(await memory.revoke(c.get("owner").id, c.req.param("id")))));
  app.post("/v1/memories/:id/enable", async (c) => c.json(presentMemory(await memory.enable(c.get("owner").id, c.req.param("id")))));
  app.delete("/v1/memories/:id", async (c) => {
    await memory.delete(c.get("owner").id, c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/v1/memories/:id/revisions", async (c) => {
    const rows = await memory.revisions(c.get("owner").id, c.req.param("id"));
    return c.json({ items: rows.map((r) => ({ revision: r.revision, value: r.value, status: r.status, changed_by: r.changedBy, changed_at: r.changedAt })) });
  });
}
