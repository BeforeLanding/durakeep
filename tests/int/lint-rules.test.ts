import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/depcruise", import.meta.url));

function cruise(cwd: string, args: string[]) {
  const bin = `${root}/node_modules/dependency-cruiser/bin/dependency-cruiser.mjs`;
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test("ADR-01 依赖规则：违规时 lint 失败", () => {
  const r = cruise(fixture, ["packages", "--config", `${root}/.dependency-cruiser.cjs`, "--output-type", "err"]);
  expect(r.code).not.toBe(0);
  expect(r.out).toMatch(/earendil-only-in-runtime-pi: packages\/core\/src\/bad-earendil\.ts/);
  expect(r.out).toMatch(/business-not-on-runtime-pi: packages\/core\/src\/bad-runtime\.ts/);
  expect(r.out).not.toMatch(/earendil-only-in-runtime-pi: packages\/runtime-pi/);
});

test("ADR-01 依赖规则：当前仓库通过", () => {
  const r = cruise(root, ["packages", "--config", ".dependency-cruiser.cjs", "--output-type", "err"]);
  expect(r.out).toBe(r.out); // 便于失败时查看输出
  expect(r.code).toBe(0);
});
