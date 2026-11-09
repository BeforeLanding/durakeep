// 静态托管前端构建产物（apps/web/dist）。路径逃逸一律放行给后续处理（404）；无扩展名的路径回退到 index.html（SPA）。
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

// 页面只加载同源资源；连接只到同源（API 与 SSE）
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function staticFiles(dir: string): MiddlewareHandler {
  const root = resolve(dir);
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path.startsWith("/v1/")) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path);
    } catch {
      return next();
    }
    const file = resolve(root, "." + rel);
    const inside = file === root || file.startsWith(root + sep);
    if (!inside) return next();
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    const target = isFile ? file : extname(rel) === "" ? resolve(root, "index.html") : undefined; // 缺失的资源文件不回退
    if (!target) return next();
    const body = await readFile(target).catch(() => undefined);
    if (!body) return next();
    const ext = extname(target);
    return c.body(new Uint8Array(body), 200, {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      ...(ext === ".html" ? { "Content-Security-Policy": CSP } : {}),
    });
  };
}
