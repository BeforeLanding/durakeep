// 07 §4.1：解析助手回答里的引用。回答正文用 [n] 标注，末尾是
//   <citations>
//   [1] chunk:1234
//   </citations>
// 这里只做文本解析（纯函数）；三项校验在 knowledge 包的 CitationValidator 里。

/** 回答里声明的一条引用。inRun 由运行时在转换助手条目时填写：这个 chunk 是否出现在同一次 run 的 kb_search / kb_get_source 结果里。 */
export type RawCitation = { n: number; chunkId: number | null; inRun: boolean };

export type ParsedAnswer = {
  /** 去掉 <citations> 块之后的可见正文。 */
  text: string;
  citations: RawCitation[];
  /** 正文里出现的 [n] 标记（去重、升序）。 */
  markers: number[];
};

const BLOCK = /<citations>([\s\S]*?)(?:<\/citations>|$)/gi;
const LINE = /^\s*\[(\d{1,3})\]\s*chunk:(\d{1,12})\s*$/;
// [n]：前面不是字母数字 / 右括号（排除 a[1]、x[0][1]），后面不是 “(”（排除 Markdown 链接）
const MARKER = /(?<![\w\]])\[(\d{1,3})\](?!\()/g;

export function parseAnswer(raw: string): ParsedAnswer {
  let last: RegExpExecArray | undefined;
  for (const m of raw.matchAll(BLOCK)) last = m; // 以最后一个块为准
  const text = (last ? raw.replace(BLOCK, "") : raw).trimEnd();
  const citations: RawCitation[] = [];
  if (last) {
    const seen = new Set<number>();
    for (const line of last[1]!.split(/\r?\n/)) {
      const m = LINE.exec(line);
      if (!m) {
        // 形如 “[2] 随便写点什么” 的行：有编号但没有合法的 chunk id → 记为无法解析（校验时判为 missing）
        const loose = /^\s*\[(\d{1,3})\]/.exec(line);
        if (loose && !seen.has(Number(loose[1]))) {
          seen.add(Number(loose[1]));
          citations.push({ n: Number(loose[1]), chunkId: null, inRun: false });
        }
        continue;
      }
      const n = Number(m[1]);
      if (seen.has(n)) continue; // 同一个编号重复出现：以第一次为准
      seen.add(n);
      citations.push({ n, chunkId: Number(m[2]), inRun: false });
    }
  }
  const markers = [...new Set([...text.matchAll(MARKER)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  return { text, citations, markers };
}

/** 流式输出中的部分文本：把还没写完的 <citations> 块整体去掉，界面不会闪过原始标签。 */
export function stripCitationsForDisplay(partial: string): string {
  const i = partial.search(/<citations/i);
  if (i >= 0) return partial.slice(0, i).trimEnd();
  // 末尾可能只写出了 “<cit” 之类的前缀
  const tail = /<(c(i(t(a(t(i(o(n(s)?)?)?)?)?)?)?)?)?$/i.exec(partial);
  return tail ? partial.slice(0, tail.index) : partial;
}
