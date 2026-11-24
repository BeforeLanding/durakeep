// 录制 README 演示 GIF：隔离启动 demo（faux 模型，零费用），用 Playwright 录屏，再由 ffmpeg 裁掉等待并导出。
// 用法：node scripts/record-demo.ts   产出 docs/assets/demo.gif（需要 ffmpeg 与本机 Edge/Chrome）
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDemo } from "../tests/support/demo.ts";

const root = join(import.meta.dirname, "..");
const work = join(root, ".tmp", "record");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const pf = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
const channel = process.env.PLAYWRIGHT_CHANNEL || (existsSync(join(pf, "Microsoft/Edge/Application/msedge.exe")) ? "msedge" : "chrome");
const size = { width: 1200, height: 720 };

const demo = await startDemo();
const browser = await chromium.launch({ channel });
const context = await browser.newContext({ viewport: size });
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
// 不依赖 Playwright 自带的录屏 ffmpeg：循环截图，记录每帧时间戳，再交给系统 ffmpeg。
const frames: { file: string; t: number }[] = [];
let recording = true;
let grabber!: Promise<void>;
const grab = () => (async () => {
  for (let i = 0; recording; i++) {
    const file = join(work, `f${String(i).padStart(5, "0")}.png`);
    const t = now();
    try { await page.screenshot({ path: file }); } catch (e) { console.error("截图失败", String(e).slice(0, 200)); break; }
    frames.push({ file, t });
  }
})();
const nav = (name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
const type = (placeholder: string | RegExp, text: string) => page.getByPlaceholder(placeholder).pressSequentially(text, { delay: 45 });
let cut: [number, number] | undefined;

try {
  await page.goto(demo.url);
  await page.getByPlaceholder("口令").fill("demodemo");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(500);
  const start = now(); // 登录前的画面不进 GIF
  grabber = grab();

  await nav("资料");
  await page.getByRole("button", { name: "粘贴文本" }).click();
  await page.getByPlaceholder("标题（可选）").fill("每周复盘");
  await page.getByPlaceholder("正文（≤50 万字符）").fill("每周五整理本周的学习笔记，归到同一个文件夹。");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: "每周复盘" }).getByText("可用", { exact: true }).waitFor();
  await page.waitForTimeout(1200);

  await nav("对话");
  await page.getByRole("button", { name: "新对话" }).click();
  await type(/问点什么/, "间隔重复应该如何安排复习？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const cite = page.locator(".msg.assistant .cite").filter({ hasText: "[1]" }).first();
  await cite.waitFor();
  await page.waitForTimeout(700);
  await cite.hover();
  await page.waitForTimeout(2600);

  await page.mouse.move(600, 600);
  await type(/问点什么/, "1分钟后提醒我复习间隔重复");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".msg.assistant").filter({ hasText: "已创建提醒" }).waitFor();
  await page.waitForTimeout(1500);

  // 调度器整分钟触发：等待段落不进 GIF，只保留触发前后各 1 秒。
  const waitFrom = now();
  await page.locator(".badge").first().waitFor({ timeout: 90_000 });
  const waitTo = now();
  cut = [waitFrom + 1, waitTo - 1];
  await page.waitForTimeout(1200);
  await page.getByRole("navigation").getByRole("link", { name: /^通知/ }).click();
  await page.getByText("复习间隔重复").first().waitFor();
  await page.waitForTimeout(2200);
  recording = false;
  await grabber;
  const kept = frames.filter((f) => f.t >= start && !(cut![1] > cut![0] && f.t > cut![0] && f.t < cut![1]));
  const list = join(work, "frames.txt");
  const q = (f: string) => `file '${f.replaceAll("\\", "/")}'`;
  writeFileSync(list, kept.map((f, i) => {
    const next = kept[i + 1];
    const d = next && next.t - f.t < 1 ? next.t - f.t : 0.1; // 裁剪处按 0.1s 接上
    return `${q(f.file)}\nduration ${d.toFixed(3)}`;
  }).join("\n") + `\n${q(kept.at(-1)!.file)}\n`);
  const gif = join(root, "docs", "assets", "demo.gif");
  const palette = join(work, "palette.png");
  const vf = "fps=10,scale=960:-1:flags=lanczos";
  const input = ["-f", "concat", "-safe", "0", "-i", list];
  execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-vf", `${vf},palettegen=max_colors=96`, palette]);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-i", palette, "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, gif]);
  console.log(`${kept.length} 帧，裁掉 ${(cut[1] - cut[0]).toFixed(1)}s 等待 → ${gif}`);
} finally {
  await browser.close().catch(() => undefined);
  await demo.stop();
}
