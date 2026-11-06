// 测试替身的再导出：测试代码不直接 import @earendil-works（ADR-01）。
export { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { fauxAssistantMessage as msg, fauxProvider as provider } from "@earendil-works/pi-ai/providers/faux";

/** test / demo 模式下服务进程使用的 faux：固定回复，零费用。 */
export function demoFaux() {
  const faux = provider();
  faux.setResponses(Array.from({ length: 10_000 }, () => () => msg("这是演示模式的回复。")));
  return faux;
}
