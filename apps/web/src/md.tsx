import { Fragment, type ReactNode } from "react";

// 极简 Markdown 渲染：只生成 React 元素（不用 innerHTML），覆盖回答里常见的结构。
// renderToken 用来把 [n] 之类的标记换成自定义节点（引用悬停）。

type Inline = (text: string, key: string) => ReactNode;

const SAFE_URL = /^(https?:\/\/|#\/)/i;

function inline(text: string, token: Inline | undefined, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // 顺序：行内代码 > 链接 > 粗体 > 斜体 > 引用标记
  const re = /(`[^`\n]+`)|(\[([^\]\n]+)\]\(([^)\s]+)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(\[\d+\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) {
      const href = m[4]!;
      out.push(SAFE_URL.test(href) ? <a key={k} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{m[3]}</a> : m[3]);
    } else if (m[5]) out.push(<strong key={k}>{inline(m[6]!, token, k)}</strong>);
    else if (m[7]) out.push(<em key={k}>{inline(m[8]!, token, k)}</em>);
    else if (m[9]) out.push(token ? <Fragment key={k}>{token(m[9], k)}</Fragment> : m[9]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, token }: { text: string; token?: Inline }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  const isTableSep = (l: string | undefined) => !!l && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }
    const fence = /^```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key()}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const k = key();
      const level = Math.min(h[1]!.length + 1, 4); // 回答里的 # 降一级显示
      const content = inline(h[2]!, token, k);
      blocks.push(level === 2 ? <h2 key={k}>{content}</h2> : level === 3 ? <h3 key={k}>{content}</h3> : <h4 key={k}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { blocks.push(<hr key={key()} />); i++; continue; }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      const k = key();
      blocks.push(<blockquote key={k}><Markdown text={body.join("\n")} token={token} /></blockquote>);
      continue;
    }
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") rows.push(cells(lines[i++]!));
      const k = key();
      blocks.push(
        <table key={k}>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, token, `${k}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, token, `${k}${ri}-${j}`)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m && /\d/.test(m[2]!) === ordered) items.push((m[1]!.length >= 2 ? "  " : "") + m[3]!);
        else if (lines[i]!.trim() !== "" && /^\s{2,}/.test(lines[i]!) && items.length) items[items.length - 1] += " " + lines[i]!.trim();
        else break;
        i++;
      }
      const k = key();
      const children = items.map((t, j) => <li key={j}>{inline(t, token, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    if (para.length === 0) para.push(lines[i++]!);
    const k = key();
    blocks.push(
      <p key={k}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, token, `${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}
