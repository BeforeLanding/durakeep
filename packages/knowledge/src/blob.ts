import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const HASH = /^[0-9a-f]{64}$/;

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/**
 * 内容寻址的 blob 存储（S12）：路径只由 sha256 决定（<root>/ab/cdef…），不使用任何用户提供的文件名。
 * 写入先写临时文件再改名，所以读到的 blob 一定是完整的；同样的内容重复写入是幂等的。
 */
export class BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  #path(hash: string): string {
    if (!HASH.test(hash)) throw new Error("无效的 blob 哈希");
    const p = join(this.root, hash.slice(0, 2), hash.slice(2));
    if (!resolve(p).startsWith(this.root + sep)) throw new Error("blob 路径越界"); // 纵深防御
    return p;
  }

  /** 写入并返回哈希。 */
  put(data: Uint8Array | string): string {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hash = sha256Hex(bytes);
    const p = this.#path(hash);
    if (existsSync(p)) return hash;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
    return hash;
  }

  has(hash: string): boolean {
    return existsSync(this.#path(hash));
  }

  get(hash: string): Buffer {
    return readFileSync(this.#path(hash));
  }

  getText(hash: string): string {
    return this.get(hash).toString("utf8");
  }

  /** 彻底删除（07 §6，P2 的 purge 使用）。 */
  delete(hash: string): void {
    rmSync(this.#path(hash), { force: true });
  }
}
