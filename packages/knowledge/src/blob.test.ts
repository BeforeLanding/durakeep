import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BlobStore, sha256Hex } from "./blob.ts";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "durakeep-blob-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function listFiles(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(d, e.name)) : [join(d, e.name)]));
}

test("按内容寻址：同样的内容得到同样的哈希与路径，重复写入幂等；读回原字节", () => {
  const s = new BlobStore(join(dir, "blobs"));
  const h1 = s.put("正文 hello");
  const h2 = s.put(Buffer.from("正文 hello", "utf8"));
  expect(h1).toBe(h2);
  expect(h1).toBe(sha256Hex("正文 hello"));
  expect(s.has(h1)).toBe(true);
  expect(s.getText(h1)).toBe("正文 hello");
  expect(listFiles(s.root)).toHaveLength(1);
  expect(listFiles(s.root)[0]).toContain(join(s.root, h1.slice(0, 2)));
  s.delete(h1);
  expect(s.has(h1)).toBe(false);
});

test("没有临时文件残留；二进制内容原样保存", () => {
  const s = new BlobStore(join(dir, "blobs"));
  const bin = new Uint8Array([0, 255, 1, 254, 2]);
  const h = s.put(bin);
  expect([...s.get(h)]).toEqual([...bin]);
  expect(listFiles(s.root).every((f) => !f.endsWith(".tmp"))).toBe(true);
});

test("S12：非哈希的 key（含 ../ 路径穿越）一律被拒绝，数据目录之外不会产生任何文件", () => {
  const root = join(dir, "data", "blobs");
  const s = new BlobStore(root);
  const evilKeys = ["../../x.md", "..\\..\\x.md", "../" + "a".repeat(62), "a".repeat(63), "A".repeat(64), "/etc/passwd", "", "%2e%2e/x"];
  for (const evil of evilKeys) {
    expect(() => s.has(evil), evil).toThrow();
    expect(() => s.get(evil), evil).toThrow();
    expect(() => s.delete(evil), evil).toThrow();
  }
  expect(existsSync(join(dir, "x.md"))).toBe(false);
  expect(existsSync(resolve(dir, "..", "x.md"))).toBe(false);
  expect(readdirSync(dir)).toEqual(["data"]);
  s.put("ok");
  expect(readdirSync(join(dir, "data"))).toEqual(["blobs"]);
});
