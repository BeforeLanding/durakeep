import { expect, test } from "vitest";
import { createRealProvider, PaidProviderForbidden } from "./provider.ts";

test.each(["test", "demo"] as const)("APP_MODE=%s 构造真实 provider 抛错", async (mode) => {
  await expect(createRealProvider(mode)).rejects.toBeInstanceOf(PaidProviderForbidden);
});

test("未知 mode 被 readAppMode 归为 test", async () => {
  const { readAppMode } = await import("@durakeep/core");
  expect(readAppMode({ APP_MODE: "whatever" })).toBe("test");
});
