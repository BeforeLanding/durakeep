// robots.txt：这是用户主动发起的单页抓取，只遵守 Disallow / Allow，不做爬取（07 §1.2）。

type Rule = { allow: boolean; pattern: string };

/** 解析 robots.txt，返回适用于 userAgentToken 的规则（精确命中的组优先，否则用 * 组）。 */
export function parseRobots(text: string, userAgentToken: string): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "disallow" || key === "allow") && cur) {
      lastWasAgent = false;
      if (value !== "") cur.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const token = userAgentToken.toLowerCase();
  const exact = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = exact.length > 0 ? exact : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function matches(pattern: string, path: string): boolean {
  // 支持 * 通配和结尾的 $
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** 最长匹配优先；长度相同 Allow 优先；没有匹配则允许。 */
export function robotsAllows(rules: Rule[], pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | undefined;
  for (const r of rules) {
    if (!matches(r.pattern, pathAndQuery)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
