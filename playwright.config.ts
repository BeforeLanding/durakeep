import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const windows = process.platform === "win32";
const edge = windows && existsSync(join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"));
const chrome = windows && existsSync(join(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"));

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./.tmp/playwright",
  timeout: 60_000,
  use: { channel: process.env.PLAYWRIGHT_CHANNEL || (edge ? "msedge" : chrome ? "chrome" : undefined) },
});
