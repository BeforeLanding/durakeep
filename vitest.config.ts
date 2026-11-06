import { defineConfig } from "vitest/config";

// 所有测试零费用：setup 文件强制 APP_MODE=test 并清除真实供应商的 key（AGENTS.md 硬规则 1）。
const setupFiles = ["./tests/setup/no-paid-calls.ts"];

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"], setupFiles } },
      { test: { name: "int", include: ["tests/int/**/*.test.ts"], setupFiles, testTimeout: 60_000 } },
      {
        test: {
          name: "recovery",
          include: ["tests/recovery/**/*.test.ts"],
          setupFiles,
          testTimeout: 600_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
