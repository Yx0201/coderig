import { test, expect } from "bun:test";
import { estimateTokens } from "./compact.ts";

// 摘要请求自己超窗口 = 压缩在最需要它的时候失效(400)。估算必须偏保守,
// 尤其是中文:CJK 约 1 字符/token,若按拉丁文的 3.5~4 一刀切会低估近 3 倍

test("中文按约 1 字符/token 估算(不再被低估)", () => {
  const zh = "这是一段纯中文的对话历史记录";
  expect(estimateTokens(zh)).toBe(zh.length);
  // 旧的一刀切 3.5 字符/token 会把它低估到不足三分之一
  expect(estimateTokens(zh)).toBeGreaterThan(Math.ceil(zh.length / 3.5) * 2);
});

test("英文按约 4 字符/token 估算(不过度高估,否则白丢历史)", () => {
  const en = "This is a plain English transcript for estimation.";
  const tok = estimateTokens(en);
  expect(tok).toBeLessThanOrEqual(Math.ceil(en.length / 3));
  expect(tok).toBeGreaterThanOrEqual(Math.floor(en.length / 5));
});

test("中英混合:各段分别计权,总量落在两个极端之间", () => {
  const zh = "纯中文内容".repeat(10);
  const en = "pure english content ".repeat(10);
  const mixed = zh + en;
  const t = estimateTokens(mixed);
  expect(t).toBe(estimateTokens(zh) + estimateTokens(en)); // 可加性
  expect(t).toBeLessThan(estimateTokens("中".repeat(mixed.length))); // 比纯中文少
  expect(t).toBeGreaterThan(Math.ceil(mixed.length / 4)); // 比纯英文多
});

test("空串与纯符号不炸", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("\n\n  ")).toBeGreaterThanOrEqual(1);
});

test("全角标点计入 CJK(中文文本里占比不小,漏算又会低估)", () => {
  expect(estimateTokens("，。！？")).toBe(4);
});

test("emoji/代理对不会被算成两个字符(按码点遍历)", () => {
  // "🎉" 是代理对,text.length 为 2 但只是一个字符;
  // 按 UTF-16 长度算会虚高,这里确认走的是码点遍历
  expect(estimateTokens("🎉")).toBe(1);
});
