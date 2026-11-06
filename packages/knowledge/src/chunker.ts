// 07 §2：以字符为单位的确定性分块（不依赖分词器）。
// 目标 600、上限 900、下限 120、重叠 80（只在同一节内部）；切分优先级：标题 → 段落 → 句末标点 → 硬切。
// 每个块记录 heading_path 与在正文中的 [char_start, char_end)（UTF-16 code unit，与 JS 的 slice 一致）。

export const CHUNKER_VERSION = "chunk1";
export const TARGET = 600;
export const MAX = 900; // 打包时的上限
export const HARD_MAX = 1020; // 合并过短块（< MIN）之后的硬上限 = MAX + MIN；没有任何块会超过它
export const MIN = 120;
export const OVERLAP = 80;

export type Chunk = {
  ordinal: number;
  headingPath: string;
  charStart: number;
  charEnd: number;
  /** 被索引与展示的文本。通常等于 body.slice(charStart, charEnd)；表格的续块在前面多出重复的表头。 */
  text: string;
  tokenEstimate: number;
};

type Kind = "heading" | "para" | "code" | "table";
type Block = { start: number; end: number; kind: Kind; level: number };
type Piece = { start: number; end: number; prefix: string; kind: Kind };
type Draft = { start: number; end: number; prefix: string; section: number; path: string; lastKind: Kind };

const SENTENCE_END = /[。！？；.!?]/;
const CJK = /[一-鿿㐀-䶿豈-﫿]/;

/** token_estimate = ceil(中文字符数 × 0.7 + 其他字符数 / 4)；只用于控制上下文预算。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.7 + other / 4);
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  let fence: string | undefined;
  let pos = 0;
  const close = () => {
    if (cur) blocks.push(cur);
    cur = undefined;
  };
  while (pos <= text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl);
    const trimmed = line.trim();
    if (fence !== undefined) {
      cur!.end = nl;
      if (trimmed.startsWith(fence)) {
        fence = undefined;
        close();
      }
    } else if (/^(```|~~~)/.test(trimmed)) {
      close();
      fence = trimmed.slice(0, 3);
      cur = { start: pos, end: nl, kind: "code", level: 0 };
    } else if (trimmed === "") {
      close();
    } else if (/^#{1,6}\s/.test(line)) {
      close();
      blocks.push({ start: pos, end: nl, kind: "heading", level: /^#+/.exec(line)![0].length });
    } else if (trimmed.startsWith("|")) {
      if (cur?.kind === "table") cur.end = nl;
      else {
        close();
        cur = { start: pos, end: nl, kind: "table", level: 0 };
      }
    } else if (cur?.kind === "para") {
      cur.end = nl;
    } else {
      close();
      cur = { start: pos, end: nl, kind: "para", level: 0 };
    }
    if (nl >= text.length) break;
    pos = nl + 1;
  }
  close();
  return blocks;
}

/** 把超过上限的块拆成不超过 MAX 的片段：段落按句末标点，代码 / 表格按行，实在不行硬切。 */
function splitBlock(text: string, b: Block): Piece[] {
  if (b.end - b.start <= MAX) return [{ start: b.start, end: b.end, prefix: "", kind: b.kind }];
  // 切分点候选：段落 = 句末标点之后；代码 / 表格 = 换行之后
  const cuts: number[] = [];
  for (let i = b.start; i < b.end; i++) {
    const ch = text[i]!;
    if (b.kind === "para" ? SENTENCE_END.test(ch) : ch === "\n") {
      let j = i + 1;
      if (b.kind === "para") while (j < b.end && /["'”’』」)）\]]/.test(text[j]!)) j++; // 句末标点后的收尾引号 / 括号
      if (j < b.end) cuts.push(j);
    }
  }
  let header = "";
  if (b.kind === "table") {
    const lines = text.slice(b.start, b.end).split("\n");
    if (lines.length >= 3 && /^\|?\s*:?-{3,}/.test(lines[1]!.trim().replace(/^\|\s*/, ""))) header = `${lines[0]}\n${lines[1]}\n`;
  }
  const pieces: Piece[] = [];
  let start = b.start;
  while (start < b.end) {
    const room = MAX - (pieces.length > 0 ? header.length : 0);
    const limit = Math.min(b.end, start + room);
    // 段落的末块要给重叠留出空间（否则最后一块装不下 80 字符的重叠）；代码 / 表格不重叠，不需要
    if (b.end - start <= (b.kind === "para" ? room - OVERLAP : room)) {
      pieces.push({ start, end: b.end, prefix: pieces.length > 0 ? header : "", kind: b.kind });
      break;
    }
    // 在 [start+MIN, limit] 内找最靠后但不超过 TARGET 之后太多的切分点：优先接近 TARGET
    let best = -1;
    for (const c of cuts) {
      if (c <= start + 1) continue;
      if (c > limit) break;
      if (c - start >= Math.min(TARGET, room) || best < 0) best = c;
      if (c - start >= Math.min(TARGET, room)) break;
    }
    const end = best > start ? best : limit; // 没有可用的切分点：硬切
    pieces.push({ start, end, prefix: pieces.length > 0 ? header : "", kind: b.kind });
    start = end;
  }
  return pieces;
}

/** 重叠起点：在上一块末尾 OVERLAP 个字符内，贴着句末标点 / 换行 / 空白之后；找不到就用原始位置。 */
function overlapStart(text: string, prevStart: number, prevEnd: number): number {
  const from = Math.max(prevStart + 1, prevEnd - OVERLAP);
  for (let i = from; i < prevEnd; i++) {
    const before = text[i - 1]!;
    if (SENTENCE_END.test(before) || before === "\n" || before === " " || before === "　") return i;
  }
  return from;
}

const isText = (k: Kind) => k === "para" || k === "heading";
const canOverlap = (prev: Draft, p: Piece) => !p.prefix && isText(prev.lastKind) && isText(p.kind);

export function chunkMarkdown(text: string): Chunk[] {
  const blocks = parseBlocks(text);
  // 1. 划分小节：标题开启新节；标题路径 = 祖先标题用 “ > ” 连接
  const stack: { level: number; title: string }[] = [];
  const sections: { path: string; pieces: Piece[] }[] = [{ path: "", pieces: [] }];
  for (const b of blocks) {
    if (b.kind === "heading") {
      const title = text.slice(b.start, b.end).replace(/^#+\s*/, "").replace(/\s*#+\s*$/, "").trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= b.level) stack.pop();
      stack.push({ level: b.level, title });
      sections.push({ path: stack.map((s) => s.title).join(" > "), pieces: [] });
    }
    sections[sections.length - 1]!.pieces.push(...splitBlock(text, b));
  }

  // 2. 在每一节内按目标长度打包（节与节之间不重叠）
  const drafts: Draft[] = [];
  sections.forEach((sec, si) => {
    let cur: Draft | undefined;
    let prev: Draft | undefined;
    for (const p of sec.pieces) {
      if (!cur) {
        cur = { start: p.start, end: p.end, prefix: p.prefix, section: si, path: sec.path, lastKind: p.kind };
        if (prev && canOverlap(prev, p)) {
          const o = overlapStart(text, prev.start, prev.end);
          if (o < cur.start && cur.end - o <= MAX) cur.start = o;
        }
        continue;
      }
      const joined = p.end - cur.start + cur.prefix.length;
      if (cur.end - cur.start < TARGET && joined <= MAX && !p.prefix) {
        cur.end = p.end;
        cur.lastKind = p.kind;
      } else {
        drafts.push(cur);
        prev = cur;
        cur = { start: p.start, end: p.end, prefix: p.prefix, section: si, path: sec.path, lastKind: p.kind };
        if (canOverlap(prev, p)) {
          const o = overlapStart(text, prev.start, prev.end);
          if (o < cur.start && cur.end - o <= MAX) cur.start = o;
        }
      }
    }
    if (cur) drafts.push(cur);
  });

  // 3. 过短的块（< MIN）与相邻块合并：优先并入同一节的前一块，其次并入后一块，最后并入前一块
  const len = (d: Draft) => d.end - d.start + d.prefix.length;
  let merged = true;
  while (merged && drafts.length > 1) {
    merged = false;
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (len(d) >= MIN) continue;
      const before = drafts[i - 1];
      const after = drafts[i + 1];
      const backLen = before ? Math.max(before.end, d.end) - before.start + before.prefix.length : Infinity;
      const fwdLen = after ? after.end - Math.min(after.start, d.start) : Infinity;
      if (before && before.section === d.section && backLen <= HARD_MAX) {
        before.end = Math.max(before.end, d.end);
        before.lastKind = d.lastKind;
        drafts.splice(i, 1);
      } else if (after && !after.prefix && fwdLen <= HARD_MAX) {
        after.start = Math.min(after.start, d.start);
        drafts.splice(i, 1);
      } else if (before && backLen <= HARD_MAX) {
        before.end = Math.max(before.end, d.end);
        before.lastKind = d.lastKind;
        drafts.splice(i, 1);
      } else continue;
      merged = true;
      break;
    }
  }

  // 4. 去掉纯空白块，输出
  const out: Chunk[] = [];
  for (const d of drafts) {
    const body = text.slice(d.start, d.end);
    if (body.trim() === "") continue;
    const t = d.prefix + body;
    out.push({ ordinal: out.length, headingPath: d.path, charStart: d.start, charEnd: d.end, text: t, tokenEstimate: estimateTokens(t) });
  }
  return out;
}
