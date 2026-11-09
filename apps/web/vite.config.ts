import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = "http://127.0.0.1:4777";
// 开发时代理到服务；服务的 Origin 校验要求与自身 origin 相等，所以改写 Origin。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target, changeOrigin: true, headers: { Origin: target } },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
