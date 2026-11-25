import { describe, expect, test } from "vitest";
import { AppError } from "@durakeep/core";
import { blocksToMarkdown, FeishuDocsClient, loginWallFor, looksLikeLoginPage, parseFeishuUrl, type Block } from "./feishu.ts";

describe("parseFeishuUrl", () => {
  test("识别 docx / wiki / 旧版 doc，以及 Lark 国际版", () => {
    expect(parseFeishuUrl("https://abc.feishu.cn/docx/AbCd123?from=from_copylink")).toEqual({ kind: "docx", token: "AbCd123", region: "feishu" });
    expect(parseFeishuUrl("https://abc.larkoffice.com/wiki/Wk9x")).toEqual({ kind: "wiki", token: "Wk9x", region: "feishu" });
    expect(parseFeishuUrl("https://abc.feishu.cn/docs/doccnX1")).toEqual({ kind: "doc", token: "doccnX1", region: "feishu" });
    expect(parseFeishuUrl("https://abc.larksuite.com/docx/Z9")).toEqual({ kind: "docx", token: "Z9", region: "lark" });
  });
  test("非飞书链接返回 undefined；飞书表格明确拒绝", () => {
    expect(parseFeishuUrl("https://example.com/docx/abc")).toBeUndefined();
    expect(parseFeishuUrl("https://notfeishu.cn/docx/abc")).toBeUndefined();
    expect(parseFeishuUrl("https://abc.feishu.cn/")).toBeUndefined();
    expect(() => parseFeishuUrl("https://abc.feishu.cn/sheets/Sh1")).toThrow(AppError);
  });
});

test("登录墙识别：已知站点与被重定向到登录页", () => {
  expect(loginWallFor("https://docs.qq.com/doc/DQ")?.code).toBe("login_required");
  expect(loginWallFor("https://example.com/a")).toBeUndefined();
  expect(looksLikeLoginPage("https://accounts.feishu.cn/accounts/page/login?app_id=2")).toBe(true);
  expect(looksLikeLoginPage("https://example.com/user/login?next=/a")).toBe(true);
  expect(looksLikeLoginPage("https://example.com/blog/how-to-login-faster")).toBe(false);
});

const t = (content: string, style: Record<string, unknown> = {}) => ({ elements: [{ text_run: { content, text_element_style: style } }] });
const DOC: Block[] = [
  { block_id: "p", block_type: 1, children: ["h1", "x", "b1", "b2", "o1", "o2", "c", "q", "tb"], page: t("周报") },
  { block_id: "h1", block_type: 3, heading1: t("本周进展") },
  { block_id: "x", block_type: 2, text: { elements: [{ text_run: { content: "完成了" } }, { text_run: { content: "检索", text_element_style: { bold: true } } }, { text_run: { content: "文档", text_element_style: { link: { url: "https%3A%2F%2Fexample.com%2Fa" } } } }] } },
  { block_id: "b1", block_type: 12, bullet: t("第一点"), children: ["b1a"] },
  { block_id: "b1a", block_type: 12, bullet: t("子项") },
  { block_id: "b2", block_type: 12, bullet: t("第二点") },
  { block_id: "o1", block_type: 13, ordered: t("步骤一") },
  { block_id: "o2", block_type: 13, ordered: t("步骤二") },
  { block_id: "c", block_type: 14, code: t("const a = 1;\n") },
  { block_id: "q", block_type: 15, quote: t("引用一句") },
  { block_id: "tb", block_type: 31, table: { property: { row_size: 2, column_size: 2 } }, children: ["c1", "c2", "c3", "c4"] },
  { block_id: "c1", block_type: 32, children: ["c1t"] },
  { block_id: "c1t", block_type: 2, text: t("名称") },
  { block_id: "c2", block_type: 32, children: ["c2t"] },
  { block_id: "c2t", block_type: 2, text: t("值") },
  { block_id: "c3", block_type: 32, children: ["c3t"] },
  { block_id: "c3t", block_type: 2, text: t("A|B") },
  { block_id: "c4", block_type: 32, children: ["c4t"] },
  { block_id: "c4t", block_type: 2, text: t("1") },
];

test("文档块转 Markdown：标题、行内样式、嵌套列表、有序列表、代码、引用、表格", () => {
  const { title, markdown } = blocksToMarkdown(DOC);
  expect(title).toBe("周报");
  expect(markdown).toBe(
    [
      "# 周报",
      "",
      "# 本周进展",
      "",
      "完成了**检索**[文档](https://example.com/a)",
      "",
      "- 第一点",
      "  - 子项",
      "",
      "- 第二点",
      "",
      "1. 步骤一",
      "",
      "2. 步骤二",
      "",
      "```",
      "const a = 1;",
      "```",
      "",
      "> 引用一句",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| A\\|B | 1 |",
      "",
    ].join("\n"),
  );
});

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const hit = Object.entries(routes).find(([k]) => path === k || path.startsWith(k + "?"));
    const body = hit ? hit[1] : { code: 1770002, msg: "not found" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("FeishuDocsClient", () => {
  const token = { code: 0, tenant_access_token: "t-1", expire: 7200 };
  test("wiki → docx：解析节点后分页读取块；令牌只取一次", async () => {
    const calls: Call[] = [];
    let page = 0;
    const base = fakeFetch(
      {
        "/open-apis/auth/v3/tenant_access_token/internal": token,
        "/open-apis/wiki/v2/spaces/get_node": { code: 0, data: { node: { obj_token: "D1", obj_type: "docx", title: "知识库页" } } },
      },
      calls,
    );
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("/docx/v1/documents/D1/blocks")) {
        calls.push({ url, init });
        page++;
        const data = page === 1
          ? { items: DOC.slice(0, 3).map((b) => (b.block_id === "p" ? { ...b, children: ["h1", "x"] } : b)), has_more: true, page_token: "n2" }
          : { items: [], has_more: false };
        return new Response(JSON.stringify({ code: 0, data }));
      }
      return base(url, init);
    };
    const client = new FeishuDocsClient({ appId: "a", appSecret: "s" }, { fetch });
    const doc = await client.read({ kind: "wiki", token: "W1", region: "feishu" });
    expect(doc.title).toBe("周报");
    expect(doc.markdown).toContain("# 本周进展");
    expect(calls.filter((c) => c.url.includes("tenant_access_token"))).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("page_token=n2"))).toBe(true);
    const authed = calls.find((c) => c.url.includes("/blocks"));
    expect((authed?.init?.headers as Record<string, string>).Authorization).toBe("Bearer t-1");
  });

  test("没有权限 → permission_denied，提示添加文档应用", async () => {
    const client = new FeishuDocsClient({ appId: "a", appSecret: "s" }, {
      fetch: fakeFetch({ "/open-apis/auth/v3/tenant_access_token/internal": token, "/open-apis/docx/v1/documents/D2/blocks": { code: 1770032, msg: "forbidden" } }),
    });
    const err = await client.read({ kind: "docx", token: "D2", region: "feishu" }).catch((e: AppError) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("permission_denied");
    expect((err as AppError).userMessage).toContain("添加文档应用");
  });

  test("凭据无效 → login_required；Lark 走国际版主机", async () => {
    const calls: Call[] = [];
    const client = new FeishuDocsClient({ appId: "a", appSecret: "bad" }, {
      fetch: fakeFetch({ "/open-apis/auth/v3/tenant_access_token/internal": { code: 10014, msg: "app secret invalid" } }, calls),
    });
    const err = await client.read({ kind: "docx", token: "D3", region: "lark" }).catch((e: AppError) => e);
    expect((err as AppError).code).toBe("login_required");
    expect(calls[0]?.url.startsWith("https://open.larksuite.com/")).toBe(true);
  });
});
