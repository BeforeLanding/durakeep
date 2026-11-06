import { expect, test } from "vitest";
import { chunkMarkdown, estimateTokens, HARD_MAX, MAX, MIN, OVERLAP, TARGET, type Chunk } from "./chunker.ts";

// 小型确定性随机数，用于“随机文档”的不变式测试
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const sentence = (n: number) => `第${n}句话讲的是间隔重复与遗忘曲线之间的关系，以及为什么要在即将遗忘时复习。`;
const para = (sentences: number, from = 0) => Array.from({ length: sentences }, (_, i) => sentence(from + i)).join("");

/** 每个块都必须满足的不变式。 */
function check(text: string, chunks: Chunk[]) {
  expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  const covered = new Uint8Array(text.length);
  for (const c of chunks) {
    expect(c.charStart).toBeGreaterThanOrEqual(0);
    expect(c.charEnd).toBeLessThanOrEqual(text.length);
    expect(c.charStart).toBeLessThan(c.charEnd);
    const slice = text.slice(c.charStart, c.charEnd);
    expect(c.text.endsWith(slice)).toBe(true); // 表格续块前面可能多出重复的表头，其余完全相等
    expect(c.text.length).toBeLessThanOrEqual(HARD_MAX); // 打包上限 MAX；合并过短块后允许到 HARD_MAX，不会无限增长
    expect(c.tokenEstimate).toBe(estimateTokens(c.text));
    for (let i = c.charStart; i < c.charEnd; i++) covered[i] = 1;
  }
  let firstGap = -1;
  for (let i = 0; i < text.length && firstGap < 0; i++) if (covered[i] === 0 && !/\s/.test(text[i]!)) firstGap = i;
  expect(firstGap, firstGap < 0 ? "" : `位置 ${firstGap} 的字符 ${JSON.stringify(text[firstGap])} 没有被任何块覆盖`).toBe(-1);
}

test("空文档 → 没有块；很短的文档 → 一个块，范围就是整篇", () => {
  expect(chunkMarkdown("")).toEqual([]);
  expect(chunkMarkdown("  \n\n ")).toEqual([]);
  const c = chunkMarkdown("只有一句话。");
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ ordinal: 0, headingPath: "", charStart: 0, charEnd: 6, text: "只有一句话。" });
});

test("确定性：同样的输入总是得到同样的块", () => {
  const text = `# 标题\n\n${para(40)}\n\n## 小节\n\n${para(30, 100)}`;
  expect(chunkMarkdown(text)).toEqual(chunkMarkdown(text));
});

test("heading_path：嵌套标题用 “ > ” 连接；遇到同级或更高级的标题时回退；标题行属于它自己那一节", () => {
  const body = (n: number) => `${para(8, n)}\n\n`;
  const text = `# 一、背景\n\n${body(0)}## 复习间隔\n\n${body(10)}### 具体数值\n\n${body(20)}## 方法\n\n${body(30)}# 二、结论\n\n${body(40)}`;
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  const paths = [...new Set(chunks.map((c) => c.headingPath))];
  expect(paths).toEqual(["一、背景", "一、背景 > 复习间隔", "一、背景 > 复习间隔 > 具体数值", "一、背景 > 方法", "二、结论"]);
  // 每一节的第一个块以它的标题行开头
  for (const p of paths) {
    const first = chunks.find((c) => c.headingPath === p)!;
    expect(first.text.trimStart().startsWith("#")).toBe(true);
  }
  // 标题之前的正文属于空路径
  expect(chunkMarkdown(`${para(5)}\n\n# 标题\n\n${para(5, 9)}`)[0]!.headingPath).toBe("");
});

test("长段落：按句末标点切分，块长落在目标与上限之间，同一节内相邻块有重叠、且重叠不超过 80 字符（贴句子边界）", () => {
  const text = `# 长文\n\n${para(120)}`;
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  expect(chunks.length).toBeGreaterThan(5);
  for (const c of chunks.slice(0, -1)) {
    expect(c.text.length).toBeGreaterThanOrEqual(MIN);
    expect(c.text.length).toBeLessThanOrEqual(MAX);
  }
  for (let i = 1; i < chunks.length; i++) {
    const overlap = chunks[i - 1]!.charEnd - chunks[i]!.charStart;
    expect(overlap, `块 ${i}`).toBeGreaterThan(0);
    expect(overlap).toBeLessThanOrEqual(OVERLAP);
    // 每个块（除第一个）从一个句子的开头开始：前一个字符是句末标点
    expect("。！？；.!?").toContain(text[chunks[i]!.charStart - 1]!);
  }
});

test("不同节之间不重叠", () => {
  const text = `# A\n\n${para(30)}\n\n# B\n\n${para(30, 50)}`;
  const chunks = chunkMarkdown(text);
  const lastA = chunks.filter((c) => c.headingPath === "A").at(-1)!;
  const firstB = chunks.find((c) => c.headingPath === "B")!;
  expect(firstB.charStart).toBeGreaterThanOrEqual(lastA.charEnd);
});

test("过短的块并入同一节的前一块；只有标题的空节并入后一块，标题不会被挂到上一节的末尾", () => {
  const text = `# 甲\n\n${para(10)}\n\n# 空节\n\n# 乙\n\n${para(10, 30)}`;
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  expect(chunks.every((c) => c.text.length >= MIN)).toBe(true);
  const withEmpty = chunks.find((c) => c.text.includes("# 空节"))!;
  expect(withEmpty.text).toContain("# 乙"); // “空节”随下一节的内容走
  const tail = chunkMarkdown(`# 标题\n\n${para(20)}\n\n结尾一句。`);
  expect(tail.at(-1)!.text).toContain("结尾一句。"); // 末尾的短段落没有变成独立的小块
});

test("没有任何标点的超长文字：硬切，每块不超过上限，全部覆盖", () => {
  const text = "字".repeat(3000);
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  expect(chunks.every((c) => c.text.length <= MAX)).toBe(true);
  expect(chunks.length).toBeGreaterThanOrEqual(4);
});

test("代码块：能放下时保持完整；超过上限时按行切开", () => {
  const small = "```ts\nconst a = 1;\nconst b = 2;\n```";
  const t1 = `# 代码\n\n说明文字。${para(3)}\n\n${small}\n\n${para(3, 9)}`;
  const c1 = chunkMarkdown(t1);
  check(t1, c1);
  expect(c1.some((c) => c.text.includes(small))).toBe(true);
  const big = "```\n" + Array.from({ length: 200 }, (_, i) => `line ${i}: some code here`).join("\n") + "\n```";
  const c2 = chunkMarkdown(big);
  check(big, c2);
  expect(c2.length).toBeGreaterThan(3);
  // 按行切：除第一块外，每块都从一行的开头开始
  for (const c of c2.slice(1)) expect(big[c.charStart - 1] === "\n" || c.charStart === 0).toBe(true);
});

test("表格：能放下时保持完整；超过上限时按行切开，续块重复表头", () => {
  const rows = Array.from({ length: 60 }, (_, i) => `| 第 ${i} 行 | ${"数据".repeat(6)} | ${i * 10} |`);
  const table = ["| 名称 | 说明 | 数值 |", "| --- | --- | --- |", ...rows].join("\n");
  const text = `# 表格\n\n${para(2)}\n\n${table}`;
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  const cont = chunks.filter((c) => c.text.startsWith("| 名称 | 说明 | 数值 |\n| --- | --- | --- |\n") && c.text !== text.slice(c.charStart, c.charEnd));
  expect(cont.length).toBeGreaterThanOrEqual(2); // 续块带着重复的表头
  for (const c of cont) expect(c.text.length).toBeLessThanOrEqual(HARD_MAX);
  // 每一行数据都出现在某个块里（没有被切坏）
  for (const r of rows) expect(chunks.some((c) => c.text.includes(r))).toBe(true);
  const small = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const c2 = chunkMarkdown(`${para(10)}\n\n${small}\n\n${para(10, 20)}`);
  expect(c2.some((c) => c.text.includes(small))).toBe(true);
});

test("token_estimate = ceil(中文 × 0.7 + 其他 / 4)", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("中文测试")).toBe(3); // 4 × 0.7 = 2.8 → 3
  expect(estimateTokens("abcdefgh")).toBe(2);
  expect(estimateTokens("中a")).toBe(1); // 0.7 + 0.25 → 1
  expect(estimateTokens("中文abcd")).toBe(3); // 1.4 + 1 = 2.4 → 3
});

test("典型文章：绝大多数块落在 [下限, 上限] 内，平均长度接近目标", () => {
  let text = "";
  for (let s = 0; s < 12; s++) text += `## 第 ${s} 节\n\n${para(14, s * 20)}\n\n${para(9, s * 20 + 50)}\n\n- 要点一\n- 要点二\n- 要点三\n\n`;
  const chunks = chunkMarkdown(text);
  check(text, chunks);
  const inRange = chunks.filter((c) => c.text.length >= MIN && c.text.length <= HARD_MAX).length;
  expect(inRange / chunks.length).toBeGreaterThanOrEqual(0.9);
  const avg = chunks.reduce((a, c) => a + c.text.length, 0) / chunks.length;
  expect(avg).toBeGreaterThan(TARGET * 0.6);
  expect(avg).toBeLessThan(MAX);
});

test("随机文档（300 篇）：覆盖、范围、长度上限等不变式始终成立", { timeout: 60_000 }, () => {
  const r = rng(20261106);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  for (let n = 0; n < 300; n++) {
    const parts: string[] = [];
    const blocks = 1 + Math.floor(r() * 14);
    for (let i = 0; i < blocks; i++) {
      const kind = pick(["h1", "h2", "h3", "p", "p", "p", "long", "list", "code", "table", "nopunct"]);
      if (kind.startsWith("h")) parts.push(`${"#".repeat(Number(kind[1]))} 标题${Math.floor(r() * 50)}`);
      else if (kind === "p") parts.push(para(1 + Math.floor(r() * 8), Math.floor(r() * 99)));
      else if (kind === "long") parts.push(para(15 + Math.floor(r() * 40), Math.floor(r() * 99)));
      else if (kind === "list") parts.push(Array.from({ length: 2 + Math.floor(r() * 12) }, (_, k) => `- 列表项 ${k} ${"内容".repeat(1 + Math.floor(r() * 9))}`).join("\n"));
      else if (kind === "code") parts.push("```\n" + Array.from({ length: 1 + Math.floor(r() * 80) }, (_, k) => `code line ${k}`).join("\n") + "\n```");
      else if (kind === "table") parts.push(["| a | b |", "| --- | --- |", ...Array.from({ length: 1 + Math.floor(r() * 50) }, (_, k) => `| 行${k} | ${"值".repeat(1 + Math.floor(r() * 20))} |`)].join("\n"));
      else parts.push("无".repeat(50 + Math.floor(r() * 2500)));
    }
    const text = parts.join(pick(["\n\n", "\n\n", "\n\n\n", "\n"]));
    check(text, chunkMarkdown(text));
  }
});
