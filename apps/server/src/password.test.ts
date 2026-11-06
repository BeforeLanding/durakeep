import { expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

const fast = { n: 2 ** 10, r: 8, p: 1 };

test("哈希格式 scrypt$N$r$p$salt$hash；同口令两次哈希不同（随机盐）；校验正确", async () => {
  const a = await hashPassword("口令 correct 123", fast);
  const b = await hashPassword("口令 correct 123", fast);
  expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  expect(a).not.toBe(b);
  expect(await verifyPassword("口令 correct 123", a)).toBe(true);
  expect(await verifyPassword("口令 correct 124", a)).toBe(false);
});

test("损坏或未知格式的哈希一律校验失败，不抛错", async () => {
  for (const bad of ["", "plain", "bcrypt$1$2$3$4$5", "scrypt$1024$8$1$only-salt"]) {
    expect(await verifyPassword("x", bad)).toBe(false);
  }
});
