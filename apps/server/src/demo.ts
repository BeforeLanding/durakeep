// pnpm demo 入口：APP_MODE=demo（faux 模型、临时数据目录、样例资料、口令 demodemo），零费用。跨平台，不依赖 shell 的环境变量语法。
process.env.APP_MODE = "demo";
for (const name of Object.keys(process.env)) {
  if (/_API_KEY$/i.test(name)) delete process.env[name];
}
await import("./main.ts");
