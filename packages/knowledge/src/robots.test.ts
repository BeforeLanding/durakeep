import { expect, test } from "vitest";
import { parseRobots, robotsAllows } from "./robots.ts";

const UA = "PersonalAgent/0.1";

test("* 组的 Disallow 生效；没有匹配规则则允许；空 Disallow 表示全部允许", () => {
  const r = parseRobots("User-agent: *\nDisallow: /private\nDisallow: /tmp/\n", UA);
  expect(robotsAllows(r, "/private/a")).toBe(false);
  expect(robotsAllows(r, "/privateer")).toBe(false); // 前缀匹配
  expect(robotsAllows(r, "/tmp/x")).toBe(false);
  expect(robotsAllows(r, "/public")).toBe(true);
  expect(robotsAllows(parseRobots("User-agent: *\nDisallow:\n", UA), "/anything")).toBe(true);
});

test("最长匹配优先，Allow 可以覆盖 Disallow；通配符与结尾 $", () => {
  const r = parseRobots("User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\nDisallow: /*.pdf$\n", UA);
  expect(robotsAllows(r, "/docs/secret")).toBe(false);
  expect(robotsAllows(r, "/docs/public/a")).toBe(true);
  expect(robotsAllows(r, "/files/a.pdf")).toBe(false);
  expect(robotsAllows(r, "/files/a.pdf?x=1")).toBe(true); // $ 锚定结尾
});

test("命中本程序名的组优先于 *；多个 User-agent 共享一组规则；注释与未知指令被忽略", () => {
  const txt = "# comment\nUser-agent: *\nDisallow: /\n\nUser-agent: OtherBot\nUser-agent: PersonalAgent\nDisallow: /x # trailing\nSitemap: https://e.com/s.xml\nCrawl-delay: 10\n";
  const r = parseRobots(txt, UA);
  expect(robotsAllows(r, "/x/1")).toBe(false);
  expect(robotsAllows(r, "/y")).toBe(true); // 精确组存在，不再套用 * 的 Disallow: /
  expect(robotsAllows(parseRobots("User-agent: Googlebot\nDisallow: /\n", UA), "/y")).toBe(true); // 与我们无关的组
  expect(robotsAllows(parseRobots("", UA), "/y")).toBe(true);
});
