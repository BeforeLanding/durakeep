import type { Provider } from "@earendil-works/pi-ai/models";
import type { AppMode } from "@durakeep/core";

/** AGENTS.md 硬规则 1：test / demo 下构造真实供应商必须抛错。检查先于任何 import，真实供应商模块不会被加载。 */
export class PaidProviderForbidden extends Error {
  constructor(mode: string) {
    super(`APP_MODE=${mode} 下禁止构造真实模型供应商（可能产生费用）；请使用 faux provider`);
    this.name = "PaidProviderForbidden";
  }
}

export async function createRealProvider(mode: AppMode): Promise<Provider> {
  if (mode !== "dev" && mode !== "prod") throw new PaidProviderForbidden(mode);
  const { deepseekProvider } = await import("@earendil-works/pi-ai/providers/deepseek");
  return deepseekProvider(); // 读取 DEEPSEEK_API_KEY
}
