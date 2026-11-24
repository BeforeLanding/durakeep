import { MIGRATIONS } from "@durakeep/db";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, openAppDatabase, startPi } from "../start.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./faux.ts";
import { upgradeFixture, upgradeModel } from "./upgrade-fixture.ts";

const dir = process.env.DATA_DIR;
if (!dir || process.env.APP_MODE !== "test") throw new Error("升级夹具只在测试模式运行");
const raw = await openAppDatabase(join(dir, "app.sqlite"));
const { task, extension } = upgradeFixture(1);
const faux = fauxProvider();
const pi = await startPi({ mode: "test", db: raw, faux, extensions: [extension], settings: { restartLimit: 2 } });
const root = await pi.harness.root(context, { agent: { model: upgradeModel } });
if (process.env.SCENARIO === "first") {
  await raw.exec("CREATE TABLE app_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter(({ id }) => id <= 10)) {
    await raw.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.run("INSERT INTO app_migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
    });
  }
  const taskId = await pi.harness.commit((tx) => tx.createTask(task, null, {
    ownership: { kind: "conversation" }, conversationId: root.id, background: true,
  }), context);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("upgrade_probe", {}), { stopReason: "toolUse" })]);
  const submission = await root.submit({ type: "input", content: "保留中的升级测试会话", requestId: "upgrade-pending" }, context);
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ taskId: String(taskId), submissionId: String(submission.id) }));
  await submission.wait(context);
} else {
  pi.harness.resume();
  await pi.harness.waitForIdle(context);
}
await pi.close();
throw new Error("预期故障点没有终止夹具");
