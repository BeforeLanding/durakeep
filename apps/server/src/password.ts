import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// 04 §3：scrypt$N$r$p$salt$hash（base64）。参数写进哈希串里，日后可以升级。
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, opts, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export async function hashPassword(password: string, params = { n: N, r: R, p: P }): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params.n, params.r, params.p);
  return `scrypt$${params.n}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}
