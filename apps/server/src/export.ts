// 导出（04 §6，FR-OPS-01）：资料、记忆、提醒白名单。
import type { SqlDatabase } from "@durakeep/db";
import type { KnowledgeService } from "@durakeep/knowledge";
import type { Owner } from "./auth.ts";
import { buildZip, type ZipEntry } from "./zip.ts";

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");

export async function buildExport(db: SqlDatabase, knowledge: KnowledgeService, owner: Owner, now: number): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  let docs = 0;
  let versions = 0;
  let cursor: string | undefined;
  do {
    const page = await knowledge.list(owner.id, { limit: 100, cursor });
    for (const d of page.items) {
      if (d.status === "purged" || d.status === "purging") continue;
      const detail = await knowledge.detail(owner.id, d.id);
      docs++;
      for (const v of detail.versions) {
        if (v.status === "purged") continue;
        const base = `documents/${d.id}/${v.id}`;
        const ext = d.sourceType === "url" ? "html" : d.sourceType === "markdown" ? "md" : "txt";
        entries.push({ name: `${base}/meta.json`, mtime: now, data: json({ document_id: d.id, version_id: v.id, title: d.title, source_type: d.sourceType, source_uri: d.sourceUri, tags: d.tags, status: d.status, version_status: v.status, captured_at: v.capturedAt, parser_version: v.parserVersion, char_count: v.charCount, summary: v.summary }) });
        const text = await knowledge.readText(owner.id, d.id, v.id).catch(() => undefined);
        if (text !== undefined) entries.push({ name: `${base}/text.md`, mtime: now, data: Buffer.from(text, "utf8") });
        const raw = await knowledge.readRaw(owner.id, d.id, v.id).catch(() => undefined);
        if (raw) entries.push({ name: `${base}/raw.${ext}`, mtime: now, data: raw.bytes });
        versions++;
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const { memories, revisionCount, schedules, occurrences } = await db.transaction(async (tx) => {
    const memoryRows = await tx.all<{ id: string; source_json: string }>(
      `SELECT id, kind, key, value, scope, status, revision, source_json, supersedes_id, confirmed_at, created_at, updated_at
         FROM app_memories WHERE owner_id = ? AND status IN ('confirmed', 'candidate') ORDER BY id`, owner.id,
    );
    const revisionRows = await tx.all<{ memory_id: string; revision: number; value: string; status: string; changed_by: string; changed_at: number }>(
      `SELECT r.memory_id, r.revision, r.value, r.status, r.changed_by, r.changed_at
         FROM app_memory_revisions r JOIN app_memories m ON m.id = r.memory_id
        WHERE m.owner_id = ? AND m.status IN ('confirmed', 'candidate') ORDER BY r.memory_id, r.revision`, owner.id,
    );
    const byMemory = new Map<string, Omit<(typeof revisionRows)[number], "memory_id">[]>();
    for (const { memory_id, ...revision } of revisionRows) {
      const previous = byMemory.get(memory_id) ?? [];
      previous.push(revision);
      byMemory.set(memory_id, previous);
    }
    const schedules = await tx.all(
      `SELECT id, conversation_id, document_id, text, local_datetime, timezone, next_fire_at, revision, status, created_at, updated_at
         FROM app_schedules WHERE owner_id = ? ORDER BY id`, owner.id,
    );
    const occurrences = await tx.all(
      `SELECT o.id, o.schedule_id, o.revision, o.fire_at, o.fired_at, o.late_ms
         FROM app_occurrences o JOIN app_schedules s ON s.id = o.schedule_id
        WHERE s.owner_id = ? ORDER BY o.fire_at, o.id`, owner.id,
    );
    return {
      memories: memoryRows.map(({ source_json, ...m }) => ({ ...m, source: JSON.parse(source_json) as unknown, revisions: byMemory.get(m.id) ?? [] })),
      revisionCount: revisionRows.length,
      schedules,
      occurrences,
    };
  });
  entries.push({ name: "memories.json", mtime: now, data: json(memories) });
  entries.push({ name: "reminders.json", mtime: now, data: json({ schedules, occurrences }) });
  entries.unshift({ name: "manifest.json", mtime: now, data: json({
    version: 1, exported_at: now, owner: { display_name: owner.displayName, timezone: owner.timezone },
    counts: { documents: docs, versions, memories: memories.length, memory_revisions: revisionCount, schedules: schedules.length, occurrences: occurrences.length },
  }) });
  return buildZip(entries);
}
