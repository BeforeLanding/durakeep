import { expect, test } from "vitest";
import { canonicalJson } from "./canonicalJson.ts";
import { opKey } from "./opKey.ts";

test("键顺序无关，undefined 被丢弃，-0 归一", () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, 1] } })).toBe('{"a":{"d":2,"e":[3,1]},"b":1}');
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  expect(canonicalJson(-0)).toBe("0");
});

test("数组顺序有意义；NaN 报错", () => {
  expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  expect(() => canonicalJson(NaN)).toThrow();
});

test("opKey：同输入同 key；任何一个分量不同则不同；定界无歧义", () => {
  const base = opKey("c1", "e1", "reminder_create", { text: "x" });
  expect(opKey("c1", "e1", "reminder_create", { text: "x" })).toBe(base);
  expect(opKey("c2", "e1", "reminder_create", { text: "x" })).not.toBe(base);
  expect(opKey("c1", "e2", "reminder_create", { text: "x" })).not.toBe(base);
  expect(opKey("c1", "e1", "reminder_cancel", { text: "x" })).not.toBe(base);
  expect(opKey("c1", "e1", "reminder_create", { text: "y" })).not.toBe(base);
  expect(opKey("c1", "e1x", "t", { a: 1 })).not.toBe(opKey("c1", "e1", "xt", { a: 1 }));
  expect(base).toMatch(/^[0-9a-f]{64}$/);
});
