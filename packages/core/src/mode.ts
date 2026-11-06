export type AppMode = "dev" | "prod" | "test" | "demo";

export function readAppMode(env: NodeJS.ProcessEnv = process.env): AppMode {
  const m = env.APP_MODE ?? "dev";
  if (m === "dev" || m === "prod" || m === "test" || m === "demo") return m;
  // 未知取值按最保守处理：当作 test，宁可拒绝真实供应商
  return "test";
}
