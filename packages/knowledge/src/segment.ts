// 07 §3.1：分词。入库和查询共用同一个函数，保证两边切出来的词一致。
// unicode61 会把连续的汉字当成一个词，所以入库前必须先用 Intl.Segmenter 切好、用空格连接。

const seg = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * 停用词：只放虚词和高频功能词（约 50 个），单独维护。
 * 刻意**不包含**否定词（不、没有、无、非）：“不支持”和“支持”意思相反，去掉会让检索结果变味。
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "的", "了", "是", "在", "和", "与", "及", "一个", "一些", "我们", "你们", "他们", "它们", "我", "你", "他", "她", "它",
  "这", "那", "这个", "那个", "这些", "那些", "就", "都", "也", "还", "而", "并", "并且", "以及", "或", "或者", "但", "但是",
  "如果", "因为", "所以", "对", "把", "被", "让", "给", "从", "到", "于", "之", "为", "以", "其", "什么", "怎么", "如何",
  "可以", "可能", "已经", "自己", "着", "过", "吗", "呢", "吧", "啊", "等",
  // 英文：只放最常见的几个
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on", "with",
]);

/** 返回词列表（NFKC + 小写；只保留“像词”的片段；去掉停用词）。 */
export function segment(text: string): string[] {
  const out: string[] = [];
  for (const s of seg.segment(text.normalize("NFKC").toLowerCase())) {
    if (s.isWordLike && !STOPWORDS.has(s.segment)) out.push(s.segment);
  }
  return out;
}

/** 写入 FTS 的文本：词用空格连接。 */
export function segmentForIndex(text: string): string {
  return segment(text).join(" ");
}

const MAX_QUERY_TOKENS = 32;

/** FTS5 的 MATCH 表达式：每个词加引号（内部的双引号加倍），用 OR 连接；没有词时返回 undefined。 */
export function buildMatchQuery(tokens: string[]): string | undefined {
  const uniq = [...new Set(tokens)].slice(0, MAX_QUERY_TOKENS);
  if (uniq.length === 0) return undefined;
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * 子串路的查询片段（07 §3.2）：只取查询中连续 ≥3 个字符的片段，取最长的 3 个。
 * 返回 undefined 表示这一路不执行。
 */
export function substringQuery(q: string): string | undefined {
  const runs = q
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((r) => Array.from(r).length >= 3);
  if (runs.length === 0) return undefined;
  const top = [...new Set(runs)].sort((a, b) => Array.from(b).length - Array.from(a).length).slice(0, 3);
  return top.map((r) => `"${r.replace(/"/g, '""')}"`).join(" OR ");
}
