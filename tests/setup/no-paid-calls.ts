// 测试进程里不允许出现任何真实供应商的凭据。即便 runtime-pi 的守卫失效，也没有 key 可用。
process.env.APP_MODE = "test";
for (const name of Object.keys(process.env)) {
  if (/_API_KEY$|^OPENAI_|^ANTHROPIC_|^DEEPSEEK_|^GEMINI_|^GOOGLE_API|^AWS_/.test(name)) delete process.env[name];
}
