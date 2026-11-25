import { AppError } from "@durakeep/core";

// 飞书 / Lark 云文档导入：网页版是登录后由前端脚本渲染的，直接抓取只能拿到登录页。
// 改为用开放平台的“自建应用”凭据（tenant_access_token）读取文档块，再转换成 Markdown。
// 只访问固定的开放平台主机，不经过通用抓取器，所以不涉及 SSRF 面。

export type FeishuLink = { kind: "docx" | "doc" | "wiki"; token: string; region: "feishu" | "lark" };

const FEISHU_HOSTS = [/(^|\.)feishu\.cn$/, /(^|\.)feishu\.net$/, /(^|\.)larkoffice\.com$/];
const LARK_HOSTS = [/(^|\.)larksuite\.com$/];

/** 识别飞书 / Lark 文档链接；不是则返回 undefined。表格、多维表格等暂不支持，抛出明确错误。 */
export function parseFeishuUrl(raw: string): FeishuLink | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  const region = FEISHU_HOSTS.some((r) => r.test(host)) ? "feishu" : LARK_HOSTS.some((r) => r.test(host)) ? "lark" : undefined;
  if (!region) return undefined;
  const m = /^\/(docx|docs|doc|wiki|sheets|base|mindnotes|file|slides)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m) return undefined;
  const [, type, token] = m as unknown as [string, string, string];
  if (type === "docx") return { kind: "docx", token, region };
  if (type === "docs" || type === "doc") return { kind: "doc", token, region };
  if (type === "wiki") return { kind: "wiki", token, region };
  throw new AppError("unsupported_type", "目前只支持导入飞书的文档和知识库页面；表格、多维表格等可导出后上传");
}

export type FeishuCredentials = { appId: string; appSecret: string };
export type FeishuDocument = { title: string; markdown: string };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type Element = {
  text_run?: { content: string; text_element_style?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; inline_code?: boolean; link?: { url: string } } };
  mention_user?: { user_id: string };
  mention_doc?: { title?: string; url?: string };
  equation?: { content: string };
};
type TextBody = { elements?: Element[]; style?: { done?: boolean; language?: number } };
export type Block = {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  table?: { property?: { row_size?: number; column_size?: number } };
} & Record<string, unknown>;

const HEADING_KEYS = ["heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "heading7", "heading8", "heading9"];

function inline(body: TextBody | undefined): string {
  return (body?.elements ?? [])
    .map((e) => {
      if (e.text_run) {
        let t = e.text_run.content;
        const s = e.text_run.text_element_style ?? {};
        if (t.trim() === "") return t;
        if (s.inline_code) t = "`" + t + "`";
        if (s.bold) t = `**${t}**`;
        if (s.italic) t = `*${t}*`;
        if (s.strikethrough) t = `~~${t}~~`;
        if (s.link?.url) t = `[${t}](${safeDecode(s.link.url)})`;
        return t;
      }
      if (e.mention_doc) return e.mention_doc.title ?? "";
      if (e.equation) return `$${e.equation.content.trim()}$`;
      return "";
    })
    .join("");
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 文档块（扁平列表，带 children）→ Markdown。不认识的块类型递归渲染其子块，不丢正文。 */
export function blocksToMarkdown(blocks: Block[]): { title: string; markdown: string } {
  const byId = new Map(blocks.map((b) => [b.block_id, b]));
  const root = blocks.find((b) => b.block_type === 1) ?? blocks[0];
  if (!root) return { title: "", markdown: "" };
  const title = inline(root["page"] as TextBody | undefined).trim();
  const out: string[] = [];

  const render = (id: string, depth: number, ordinal: number): void => {
    const b = byId.get(id);
    if (!b) return;
    const indent = "  ".repeat(depth);
    const kids = b.children ?? [];
    const renderKids = (d: number) => {
      let n = 0;
      for (const k of kids) render(k, d, byId.get(k)?.block_type === 13 ? ++n : (n = 0));
    };
    const t = b.block_type;
    if (t >= 3 && t <= 11) {
      out.push(`${"#".repeat(Math.min(t - 2, 6))} ${inline(b[HEADING_KEYS[t - 3]!] as TextBody).trim()}`, "");
      renderKids(depth);
    } else if (t === 2) {
      const s = inline(b["text"] as TextBody);
      if (s.trim() !== "") out.push(indent + s, "");
      renderKids(depth + 1);
    } else if (t === 12 || t === 13 || t === 17) {
      const key = t === 12 ? "bullet" : t === 13 ? "ordered" : "todo";
      const body = b[key] as TextBody;
      const mark = t === 12 ? "-" : t === 13 ? `${ordinal}.` : body?.style?.done ? "- [x]" : "- [ ]";
      out.push(`${indent}${mark} ${inline(body)}`);
      renderKids(depth + 1);
      if (depth === 0) out.push("");
    } else if (t === 14) {
      out.push("```", inline(b["code"] as TextBody).replace(/\n$/, ""), "```", "");
    } else if (t === 15) {
      out.push(`> ${inline(b["quote"] as TextBody)}`, "");
    } else if (t === 22) {
      out.push("---", "");
    } else if (t === 31) {
      const cols = b.table?.property?.column_size ?? 1;
      const cells = kids.map((cid) => cellText(cid));
      for (let r = 0; r * cols < cells.length; r++) {
        out.push("| " + cells.slice(r * cols, r * cols + cols).join(" | ") + " |");
        if (r === 0) out.push("|" + " --- |".repeat(cols));
      }
      out.push("");
    } else if (t === 34 || t === 19) {
      // 引用容器、高亮块：子块逐行加引用前缀
      const start = out.length;
      renderKids(0);
      for (let i = start; i < out.length; i++) if (out[i] !== "") out[i] = "> " + out[i];
      out.push("");
    } else {
      renderKids(depth);
    }
  };

  const cellText = (id: string): string => {
    const b = byId.get(id);
    if (!b) return "";
    const parts: string[] = [];
    for (const k of b.children ?? []) {
      const c = byId.get(k);
      if (!c) continue;
      const key = c.block_type === 2 ? "text" : c.block_type === 12 ? "bullet" : c.block_type === 13 ? "ordered" : undefined;
      if (key) parts.push(inline(c[key] as TextBody));
    }
    return parts.join(" ").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  };

  let n = 0;
  for (const k of root.children ?? []) render(k, 0, byId.get(k)?.block_type === 13 ? ++n : (n = 0));
  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, markdown: (title ? `# ${title}\n\n` : "") + body + "\n" };
}

/** 开放平台错误码 → 用户能看懂、知道怎么处理的错误。 */
function apiError(code: number, msg: string, what: string): AppError {
  const forbidden = new Set([1770032, 1770040, 131006, 91204, 95009, 2890003, 1063003]);
  const notFound = new Set([1770002, 131005, 91201, 95008, 1770003]);
  const scope = new Set([99991672, 99991679, 99991400]);
  const badCred = new Set([10003, 10014, 99991663, 99991664, 99991665, 99991661]);
  if (forbidden.has(code)) {
    return new AppError("permission_denied", `飞书应用没有这篇${what}的阅读权限：在文档右上角「…」→「添加文档应用」里添加你的应用后重试`, { feishu_code: code });
  }
  if (notFound.has(code)) return new AppError("not_found", `飞书${what}不存在或已被删除`, { feishu_code: code });
  if (scope.has(code)) {
    return new AppError("permission_denied", "飞书应用缺少权限：请在开放平台为应用开通 docx:document:readonly 与 wiki:wiki:readonly，并发布版本", { feishu_code: code });
  }
  if (badCred.has(code)) return new AppError("login_required", "飞书应用凭据无效：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET", { feishu_code: code });
  return new AppError("fetch_failed", `飞书接口返回错误（${code}）：${msg.slice(0, 80)}`, { feishu_code: code, retryable: code >= 1000 && code < 2000 ? false : true });
}

export class FeishuDocsClient {
  readonly #cred: FeishuCredentials;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(cred: FeishuCredentials, options: { fetch?: Fetch; timeoutMs?: number } = {}) {
    this.#cred = cred;
    this.#fetch = options.fetch ?? ((u, i) => fetch(u, i));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  static base(region: FeishuLink["region"]): string {
    return region === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  }

  async #call<T>(base: string, path: string, what: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (auth) headers.Authorization = `Bearer ${await this.#tenantToken(base)}`;
    let res: Response;
    try {
      res = await this.#fetch(base + path, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new AppError("fetch_timeout", "连接飞书超时", { retryable: true });
      throw new AppError("fetch_failed", "无法连接到飞书开放平台", { retryable: true });
    }
    let json: { code?: number; msg?: string; data?: T } & Record<string, unknown>;
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new AppError("fetch_failed", `飞书接口返回了无法解析的响应（HTTP ${res.status}）`, { retryable: res.status >= 500 });
    }
    if (json.code !== 0) throw apiError(json.code ?? res.status, json.msg ?? "", what);
    return (json.data ?? json) as T;
  }

  async #tenantToken(base: string): Promise<string> {
    const hit = this.#tokens.get(base);
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
    const r = await this.#call<{ tenant_access_token: string; expire: number }>(
      base,
      "/open-apis/auth/v3/tenant_access_token/internal",
      "文档",
      { method: "POST", body: JSON.stringify({ app_id: this.#cred.appId, app_secret: this.#cred.appSecret }) },
      false,
    );
    this.#tokens.set(base, { token: r.tenant_access_token, expiresAt: Date.now() + r.expire * 1000 });
    return r.tenant_access_token;
  }

  /** 读取一篇飞书文档，返回标题和 Markdown 正文。 */
  async read(link: FeishuLink): Promise<FeishuDocument> {
    const base = FeishuDocsClient.base(link.region);
    let kind: string = link.kind;
    let token = link.token;
    let title = "";
    if (link.kind === "wiki") {
      const r = await this.#call<{ node: { obj_token: string; obj_type: string; title?: string } }>(
        base,
        `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
        "知识库页面",
      );
      kind = r.node.obj_type;
      token = r.node.obj_token;
      title = r.node.title ?? "";
      if (kind !== "docx" && kind !== "doc") {
        throw new AppError("unsupported_type", "这个知识库页面不是文档（可能是表格或多维表格），目前只支持导入文档");
      }
    }
    if (kind === "doc") {
      const raw = await this.#call<{ content: string }>(base, `/open-apis/doc/v2/${encodeURIComponent(token)}/raw_content`, "文档");
      if (!title) {
        title = await this.#call<{ title?: string }>(base, `/open-apis/doc/v2/meta/${encodeURIComponent(token)}`, "文档").then((m) => m.title ?? "", () => "");
      }
      return { title, markdown: (title ? `# ${title}\n\n` : "") + raw.content.trim() + "\n" };
    }
    const blocks: Block[] = [];
    let pageToken = "";
    for (let page = 0; page < 200; page++) {
      const q = new URLSearchParams({ page_size: "500", document_revision_id: "-1" });
      if (pageToken) q.set("page_token", pageToken);
      const r = await this.#call<{ items?: Block[]; has_more?: boolean; page_token?: string }>(
        base,
        `/open-apis/docx/v1/documents/${encodeURIComponent(token)}/blocks?${q}`,
        "文档",
      );
      blocks.push(...(r.items ?? []));
      if (!r.has_more || !r.page_token) break;
      pageToken = r.page_token;
    }
    const md = blocksToMarkdown(blocks);
    if (md.markdown.replace(/^#.*$/m, "").trim() === "") throw new AppError("extract_failed", "这篇飞书文档没有可导入的文字内容");
    return { title: md.title || title, markdown: md.markdown };
  }
}

/** 从环境变量读取凭据；没配置返回 undefined。 */
export function feishuDocsFromEnv(env: Record<string, string | undefined>): FeishuDocsClient | undefined {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return undefined;
  return new FeishuDocsClient({ appId, appSecret });
}

/** 已知需要登录、由前端脚本渲染的站点：抓到的只会是登录页或空壳。 */
const LOGIN_WALL_HOSTS: { re: RegExp; name: string; hint: string }[] = [
  { re: /(^|\.)docs\.qq\.com$/, name: "腾讯文档", hint: "请在腾讯文档里导出为 Word / Markdown 后上传，或复制正文粘贴" },
  { re: /(^|\.)notion\.(so|site)$/, name: "Notion", hint: "请在 Notion 里导出为 Markdown 后上传，或复制正文粘贴" },
  { re: /(^|\.)(dingtalk|alidocs\.dingtalk)\.com$/, name: "钉钉文档", hint: "请导出为 Word 后上传，或复制正文粘贴" },
  { re: /(^|\.)shimo\.im$/, name: "石墨文档", hint: "请导出为 Word / Markdown 后上传，或复制正文粘贴" },
];

export function loginWallFor(raw: string): AppError | undefined {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const hit = LOGIN_WALL_HOSTS.find((h) => h.re.test(host));
  return hit ? new AppError("login_required", `${hit.name}需要登录才能查看，无法直接抓取。${hit.hint}`) : undefined;
}

/** 抓取的最终地址是登录页（被重定向到登录）时判定为需要登录。 */
export function looksLikeLoginPage(finalUrl: string): boolean {
  try {
    const u = new URL(finalUrl);
    return /^(accounts|passport|login|sso|auth|signin)\./i.test(u.hostname) || /\/(login|signin|sign_in|passport|sso)(\/|$|\?)/i.test(u.pathname);
  } catch {
    return false;
  }
}
