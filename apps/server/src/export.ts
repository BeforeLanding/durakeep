// 导出（04 §6，FR-OPS-01）：manifest + 每个资料版本的 raw / text.md / meta.json。
// 排除 app_auth、app_sessions、app_operations、app_events 和 pi_*（对话记录属 P3）；记忆与提醒在 P2 加入后写入 memories.json / reminders.json。
import type { KnowledgeService } from "@durakeep/knowledge";
import { buildZip, type ZipEntry } from "./zip.ts";

const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n", "utf8");

export async function buildExport(knowledge: KnowledgeService, owner: { id: string; displayName: string; timezone: string }, now: number): Promise<Buffer> {
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
  entries.unshift({ name: "manifest.json", mtime: now, data: json({ version: 1, exported_at: now, owner: { display_name: owner.displayName, timezone: owner.timezone }, counts: { documents: docs, versions } }) });
  return buildZip(entries);
}
