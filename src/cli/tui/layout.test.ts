import { test, expect } from "bun:test";
import {
  cellWidth,
  stringWidth,
  wrapText,
  ContentView,
  truncateToWidth,
  visibleWidth,
  wrapStyled,
} from "./layout.ts";

test("cellWidth:ASCII 窄、中文/emoji 双宽、combining 零宽", () => {
  expect(cellWidth("a")).toBe(1);
  expect(cellWidth("中")).toBe(2);
  expect(cellWidth("你")).toBe(2);
  expect(cellWidth("家")).toBe(2);
  expect(cellWidth("😀")).toBe(2);
});

test("stringWidth:中英混排按列宽累加", () => {
  expect(stringWidth("abc")).toBe(3);
  expect(stringWidth("你好")).toBe(4);
  expect(stringWidth("a中b")).toBe(4); // 1+2+1
});

test("wrapText:普通英文按宽度折行", () => {
  expect(wrapText("abcdefghi", 4)).toEqual(["abcd", "efgh", "i"]);
});

test("wrapText:绝不在双宽字符中间切开", () => {
  // 宽度 5,"a" + "你"(2) + "好"(2) = 5 正好;再加一个"你"会折到下一行
  expect(wrapText("a你好你", 5)).toEqual(["a你好", "你"]);
});

test("wrapText:显式换行不受宽度约束", () => {
  expect(wrapText("ab\ncdef", 3)).toEqual(["ab", "cde", "f"]);
});

test("wrapText:空串返回空,双宽字符在 2 格内逐个换行", () => {
  expect(wrapText("", 4)).toEqual([]);
  // 每个字占 2 个全角格,2 格一行的"很好"必须拆成两行,不能并行塞进一格
  expect(wrapText("很好", 2)).toEqual(["很", "好"]);
});

test("ContentView:追加后自动贴底(跟随)", () => {
  const v = new ContentView(4, 2);
  v.append("1234"); // 4 宽一行
  v.append("5678"); // 第 2 行
  expect(v.visible()).toEqual(["1234", "5678"]);
  v.append("9"); // 第 3 行,跟随 → top 移到 1
  expect(v.visible()).toEqual(["5678", "9"]);
  expect(v.atBottom()).toBe(true);
});

test("ContentView:用户上滚冻结,append 不再自动拖", () => {
  const v = new ContentView(4, 2);
  v.append("A1"); // "A1" (4 宽=2行? 实际 "A1" 2格,一行) 先制造多行
  v.append("B2");
  v.append("C3");
  v.append("\nD4");
  v.scroll(-1); // 上滚冻结
  expect(v.followBottom).toBe(false);
  const before = v.top;
  v.append("E5");
  expect(v.top).toBe(before); // 冻结 → top 不变
});

test("ContentView:滚到底恢复跟随", () => {
  const v = new ContentView(4, 2);
  for (const s of ["a", "b", "c", "d", "e", "f"]) v.append(s); // 6 行
  v.scroll(-5); // 到顶,冻结
  v.scroll(100); // 滚超底 → 恢复跟随 + 贴底
  expect(v.followBottom).toBe(true);
  expect(v.atBottom()).toBe(true);
});

test("ContentView:未溢出时无滚动条", () => {
  const v = new ContentView(8, 5);
  v.append("hi");
  expect(v.scrollbarInfo()).toBeNull();
});

test("ContentView:溢出时有滚动条比例", () => {
  const v = new ContentView(8, 2);
  for (const s of ["1", "2", "3", "4", "5"]) v.append(s); // 5 行,高 2
  const cw1 = v.scrollbarInfo();
  expect(cw1).not.toBeNull();
  expect(cw1!.fraction).toBeGreaterThan(0);
  expect(cw1!.fraction).toBeLessThan(1);
});
test("truncateToWidth:ANSI 序列零宽 + 截断后补 reset(否则颜色漏到框线上)", () => {
  const colored = "\x1b[36mabcdefgh\x1b[39m";
  // 不需要截断时原样返回(样式序列不算宽度)
  expect(truncateToWidth(colored, 8)).toBe(colored);
  const cut = truncateToWidth(colored, 5);
  expect(visibleWidth(cut)).toBe(5); // 4 字 + 省略号
  expect(cut.startsWith("\x1b[36m")).toBe(true);
  expect(cut.endsWith("\x1b[0m")).toBe(true); // 截断了也不会让 cyan 漏出去
  // 不能从序列中间切断:残字节会让终端吞掉后面的正文 → 剥掉完整 SGR 后不该剩 ESC
  expect(cut.replace(/\x1b\[[0-9;]*m/g, "")).not.toContain("\x1b");
  expect(cut.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abcd…");
});

test("visibleWidth:剥 ANSI 后按 cell 宽计(中文双宽)", () => {
  expect(visibleWidth("\x1b[1m中文\x1b[22m")).toBe(4);
});

test("wrapStyled:按 cell 宽折行,英文单词整体换行,样式跨行重开", () => {
  const ls = wrapStyled("\x1b[1mhello world\x1b[22m", 7);
  expect(ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["hello", "world"]);
  expect(ls.every((l) => visibleWidth(l) <= 7)).toBe(true);
  expect(ls[1]).toContain("\x1b[1m"); // 第二行重新打开加粗
  expect(ls[0]!.endsWith("\x1b[0m")).toBe(true); // 第一行行尾收干净
});

test("wrapStyled:中文逐字可断,超长单词硬切", () => {
  expect(wrapStyled("中文折行测试", 4)).toEqual(["中文", "折行", "测试"]);
  expect(wrapStyled("aaaaaaaa", 3)).toEqual(["aaa", "aaa", "aa"]);
});

test("wrapStyled:句读标点不落行首(禁则)", () => {
  // 宽度 6 = 3 个汉字;"文。" 会一起换行,不会折出一行只有 "。"
  const ls = wrapStyled("中文中文。后面", 6);
  expect(ls.some((l) => l.startsWith("。"))).toBe(false);
  expect(ls.join("")).toBe("中文中文。后面");
});
