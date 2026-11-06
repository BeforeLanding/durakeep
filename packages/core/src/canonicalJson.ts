
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

/** 稳定序列化：对象键按字典序、丢弃 undefined、数组保持顺序（需要“集合语义”的字段由调用方先排序）。 */
export function canonicalJson(value: Json | undefined): string {
  if (value === undefined) throw new TypeError("canonicalJson: 顶层值不能是 undefined");
  return stringify(value);
}

function stringify(v: Json | undefined): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonicalJson: 不支持 NaN / Infinity");
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  if (v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map((x) => stringify(x === undefined ? null : x)).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(v[k])}`).join(",")}}`;
}
