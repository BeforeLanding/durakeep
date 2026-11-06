import { expect, test } from "vitest";
import { FakeClock } from "@durakeep/core";
import { latestThrottle } from "./throttle.ts";

test("首个值立即发送；窗口内的多个值只发最新的一个；窗口过后再次立即发送", () => {
  const clock = new FakeClock(0);
  const out: number[] = [];
  const t = latestThrottle<number>(clock, 100, (v) => out.push(v));
  t.push(1);
  t.push(2);
  t.push(3);
  expect(out).toEqual([1]);
  clock.advance(99);
  expect(out).toEqual([1]);
  clock.advance(1);
  expect(out).toEqual([1, 3]); // 2 被合并掉
  clock.advance(500);
  t.push(4);
  expect(out).toEqual([1, 3, 4]);
});

test("close 之后不再发送，排定的定时器被取消", () => {
  const clock = new FakeClock(0);
  const out: number[] = [];
  const t = latestThrottle<number>(clock, 100, (v) => out.push(v));
  t.push(1);
  t.push(2);
  t.close();
  clock.advance(1000);
  t.push(3);
  expect(out).toEqual([1]);
});
