import { fault } from "@durakeep/core";
import { defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";

export const UPGRADE_SECRET = "upgrade-private-diagnostic-sentinel";
export const upgradeModel = { provider: "faux", modelId: "faux-1" };
const tool = defineTool({
  name: "upgrade_probe",
  description: "可重放的升级测试工具",
  parameters: obj({}),
  callers: ["model"],
  replay: "safe",
  execute: async () => {
    fault("tool.in_execute");
    return { output: [{ type: "text", text: "fixture resumed" }] };
  },
});

export function upgradeFixture(version: 1 | 2) {
  const task = defineTask<null, { phase: "hold" }, null>({
    name: "fixture.upgrade",
    version,
    initial: () => ({ phase: "hold" }),
    ...(version === 2 ? { migrate: () => { throw new Error(UPGRADE_SECRET); } } : {}),
    phases: {
      hold: async (_task, runtime, ctx) => {
        await runtime.sleepUntil(runtime.now() + 600_000, { phase: "hold" }, ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  return { task, extension: defineExtension({ name: "upgrade-fixture", tasks: [task], tools: [tool] }) };
}
