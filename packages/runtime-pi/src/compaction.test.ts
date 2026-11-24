import { expect, test } from "vitest";
import { appCompaction } from "./compaction.ts";
import { PiRuntime } from "./runtime.ts";
import { context, startPi } from "./start.ts";
import { fauxAssistantMessage, fauxProvider } from "./testing/faux.ts";

const modelRef = { provider: "faux", modelId: "faux-1" };
const summary = "s".repeat(80);
const productionPolicy = appCompaction.modelOverrides["deepseek/deepseek-v4-pro"];

test.each([
  { trigger: "background", contextWindow: 1_000_000, reserveTokens: 936_000, next: 112_000, normalLimit: undefined, summaryLimit: 384_000 },
  { trigger: "blocking", contextWindow: 1_000_000, reserveTokens: 936_000, next: 172_000, normalLimit: 20_000, summaryLimit: 384_000 },
  { trigger: "blocking", contextWindow: 68_000, reserveTokens: 4_000, next: 172_000, normalLimit: 20_000, summaryLimit: 3_200 },
])("$trigger：reserveTokens=$reserveTokens，捕获普通回答和压缩摘要的输出上限", async ({ trigger, contextWindow, reserveTokens, next, normalLimit, summaryLimit }) => {
  const maxTokens = 384_000;
  const faux = fauxProvider({ models: [{ id: modelRef.modelId, contextWindow, maxTokens }] });
  const requests: { compact: boolean; maxTokens: number | undefined; modelMax: number }[] = [];
  faux.setResponses(Array.from({ length: 4 }, () => (messages, options, _state, model) => {
    const compact = messages.messages.some((m) => m.role === "system" && String(m.content).includes("context summarization assistant"));
    requests.push({ compact, maxTokens: options?.maxTokens, modelMax: model.maxTokens });
    return fauxAssistantMessage(compact ? summary : "norm");
  }));
  // 1.5.0 的公开 ConversationStreamOptions 没有 maxTokens。
  // 对照组用原始测试对象验证该字段在内部透传时也不会被 reserveTokens 改写。
  const stream = { timeoutMs: 120_000, ...(normalLimit === undefined ? {} : { maxTokens: normalLimit }) };
  const pi = await startPi({
    mode: "test", faux, settings: {
      stream,
      compaction: { ...appCompaction, modelOverrides: { "faux/faux-1": { ...productionPolicy, reserveTokens } } },
    },
  });
  const runtime = new PiRuntime(pi, { model: modelRef });
  try {
    runtime.resume();
    const { piConversationId } = await runtime.createConversation({ kind: "chat" });
    const submit = async (text: string, id: string) => {
      const { submissionId } = await runtime.submitInput(piConversationId, { text, requestId: id, steer: false, now: 0, tz: "UTC" });
      expect(await runtime.waitSubmission(submissionId)).toEqual({ status: "done", answerText: "norm" });
      await pi.harness.waitForIdle(context);
    };
    await submit("a".repeat(100_000), "first");
    expect(requests).toEqual([{ compact: false, maxTokens: normalLimit, modelMax: maxTokens }]);
    expect((await runtime.usage()).models["faux/faux-1"]?.output).toBe(1);
    await submit("b".repeat(next), "second");
    expect(requests).toHaveLength(3);
    if (trigger === "blocking") expect(requests[1]?.compact).toBe(true);
    expect(requests.filter(({ compact }) => !compact)).toEqual([
      { compact: false, maxTokens: normalLimit, modelMax: maxTokens },
      { compact: false, maxTokens: normalLimit, modelMax: maxTokens },
    ]);
    expect(requests.find(({ compact }) => compact)).toEqual({ compact: true, maxTokens: summaryLimit, modelMax: maxTokens });
    const usage = (await runtime.usage()).models["faux/faux-1"];
    expect(usage?.output).toBe(22); // 两条回答各 1，压缩摘要 20
    expect(usage?.input).toBeGreaterThan(0); // 摘要请求关闭缓存
    expect((await runtime.loadEarlier(piConversationId, undefined, 20)).entries.some((entry) => entry.kind === "compaction")).toBe(true);
  } finally {
    await runtime.close();
  }
}, 25_000);
