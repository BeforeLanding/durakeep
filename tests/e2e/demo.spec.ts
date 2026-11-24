import { expect, test } from "@playwright/test";
import { startDemo } from "../support/demo.ts";

test("FR-OPS-05：登录、收藏、引用、记忆、提醒和健康页", async ({ page }) => {
  const demo = await startDemo();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const nav = (name: string) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
  try {
    await page.goto(demo.url);
    await page.getByPlaceholder("口令").fill("demodemo");
    await page.getByRole("button", { name: "登录" }).click();
    await nav("资料");
    const doc = (name: string) => page.getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });
    for (const title of ["间隔重复学习法", "咖啡冲煮笔记", "周会记录 2026-11-02"]) {
      await expect(doc(title).getByText("可用", { exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "粘贴文本" }).click();
    await page.getByPlaceholder("标题（可选）").fill("冒烟测试资料");
    await page.getByPlaceholder("正文（≤50 万字符）").fill("每周将学习笔记整理到一个文件夹，方便继续补充。");
    await page.getByRole("button", { name: "收藏", exact: true }).click();
    await expect(doc("冒烟测试资料").getByText("可用", { exact: true })).toBeVisible();

    await nav("对话");
    await page.getByRole("button", { name: "新对话" }).click();
    const send = async (text: string) => {
      await page.getByPlaceholder(/问点什么/).fill(text);
      await page.getByRole("button", { name: "发送", exact: true }).click();
    };
    await send("间隔重复应该如何安排复习？");
    const answer = page.locator(".msg.assistant").filter({ hasText: "根据你收藏的资料" });
    const citation = answer.locator(".cite").filter({ hasText: "[1]" }).first();
    await expect(citation).toBeVisible();
    await expect(citation).not.toHaveClass(/\bbad\b/);
    await citation.hover();
    await expect(citation.locator(".tip")).toContainText("在即将遗忘时复习");
    await expect(answer.getByText("引用无效")).toHaveCount(0);

    await send("记住我喜欢简短总结");
    await expect(page.locator(".msg.assistant").filter({ hasText: "已记住" })).toContainText("我喜欢简短总结");
    await nav("记忆");
    await expect(page.getByRole("button", { name: "已确认" })).toBeVisible();
    await expect(page.getByText("我喜欢简短总结", { exact: true })).toBeVisible();

    await nav("对话");
    // “对话”导航回到列表，再打开刚创建的会话。
    await page.getByRole("complementary").getByRole("link").first().click();
    await send("明天晚上八点提醒我复习间隔重复");
    await expect(page.locator(".msg.assistant").filter({ hasText: "已创建提醒" })).toContainText(/20:00 星期[日一二三四五六].*Asia\/Shanghai/);
    await nav("提醒");
    await expect(page.getByText("复习间隔重复", { exact: true })).toBeVisible();
    await expect(page.getByText(/20:00 星期[日一二三四五六].*Asia\/Shanghai/)).toBeVisible();

    await nav("设置");
    await expect(page.getByRole("heading", { name: "设置 / 健康" })).toBeVisible();
    await expect(page.getByText("数据库逻辑大小", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存设置" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    try {
      await page.close();
    } finally {
      await demo.stop();
    }
  }
});
