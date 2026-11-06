import { expect, test } from "vitest";
import { uuidv7 } from "./id.ts";
import { FakeClock } from "./clock.ts";

test("uuidv7：格式、版本位、时间前缀可排序", () => {
  const a = uuidv7(1_000_000_000_000);
  const b = uuidv7(1_000_000_000_001);
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});

test("FakeClock：advance 按时间顺序触发定时器，取消生效", () => {
  const c = new FakeClock(0);
  const fired: number[] = [];
  c.setTimer(() => fired.push(2), 200);
  c.setTimer(() => fired.push(1), 100);
  const cancel = c.setTimer(() => fired.push(3), 150);
  cancel();
  c.advance(250);
  expect(fired).toEqual([1, 2]);
  expect(c.now()).toBe(250);
});
