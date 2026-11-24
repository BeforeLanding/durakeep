import type { HarnessSettings } from "@earendil-works/pi-durable";

const deepseek = { reserveTokens: 936_000, keepRecentTokens: 16_000, backgroundTokens: 16_000 };

export const appCompaction = {
  enabled: true,
  modelOverrides: {
    "deepseek/deepseek-flash": deepseek,
    "deepseek/deepseek-v4-pro": deepseek,
  },
} satisfies NonNullable<HarnessSettings["compaction"]>;
