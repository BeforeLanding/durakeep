import { afterEach, expect, test, vi } from "vitest";
import { fault, resetFaultHits } from "./fault.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetFaultHits();
});

test("未设置 FAULT_POINT 时不动作", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  fault("a", {});
  expect(kill).not.toHaveBeenCalled();
});

test("第 N 次命中才 SIGKILL 自身", () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const env = { FAULT_POINT: "a", FAULT_HIT: "3" };
  fault("a", env);
  fault("b", env);
  fault("a", env);
  expect(kill).not.toHaveBeenCalled();
  fault("a", env);
  expect(kill).toHaveBeenCalledWith(process.pid, "SIGKILL");
});
