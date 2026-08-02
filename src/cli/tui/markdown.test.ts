import { test, expect } from "bun:test";
import { renderMarkdown } from "./markdown.ts";
import { stringWidth } from "./layout.ts";

// 非 TTY 下 picocolors 自动去色,产出是纯文本 → 结构断言不受 ANSI 干扰

test("标题带 # 前缀", () => {
  const out = renderMarkdown("# 标题");
  expect(out).toContain("# 标题");
});

test("粗体/斜体/行内码:内容在,但原始记号不泄漏", () => {
  const b = renderMarkdown("**加粗**");
  expect(b).toContain("加粗");
  expect(b).not.toContain("**"); // 关键:strong 经 parseInline 渲染,不能漏原星号

  const e = renderMarkdown("*斜体*");
  expect(e).toContain("斜体");
  expect(e).not.toContain("*");

  const c = renderMarkdown("用 `code` 调用");
  expect(c).toContain("code");
  expect(c).not.toContain("`"); // 行内码不能漏反引号
});

test("段落自动换行", () => {
  expect(renderMarkdown("一\n二")).toContain("一");
  expect(renderMarkdown("一\n二")).toContain("二");
});

test("代码块:lowlight 高亮 + 语言标注 + 不吐原始 markdown 围栏", () => {
  const md = "```ts\nconst x: number = 1;\n```";
  const out = renderMarkdown(md);
  expect(out).toContain(" ts "); // 语言标注在上框线里
  expect(out).toContain("const x: number = 1;");
  expect(out).not.toContain("```");
});

test("代码块:空围栏不画空框(模型偶尔吐 ```\\n```)", () => {
  expect(renderMarkdown("```\n```").trim()).toBe("");
  expect(renderMarkdown("```bash\n\n```").trim()).toBe("");
});

test("代码块/行内码:HTML 实体还原成字面量", () => {
  const out = renderMarkdown("```ts\nif (a && b) {}\n```");
  expect(out).toContain("a && b");
  expect(out).not.toContain("&amp;");
  expect(renderMarkdown("用 `a && b` 判断")).toContain("a && b");
  expect(renderMarkdown("值 5 > 3 成立")).not.toContain("&gt;");
});

test("行内代码保留", () => {
  expect(renderMarkdown("用 `foo` 调用")).toContain("foo");
});

test("列表项带前缀", () => {
  const out = renderMarkdown("- a\n- b");
  expect(out).toContain("a");
  expect(out).toContain("b");
});

test("链接:保留 href 供点击/查阅", () => {
  const out = renderMarkdown("[x](https://example.com)");
  expect(out).toContain("https://example.com");
  expect(out).not.toContain("[x]"); // 链接 label 不能漏原始记号
});

test("表格:渲染成行列,不出原始 | 和分隔线", () => {
  const md = "| 名 | 值 |\n|---|---|\n| a | 1 |";
  const out = renderMarkdown(md);
  expect(out).toContain("名");
  expect(out).toContain("a");
  expect(out).not.toContain("|");
  expect(out).not.toContain("---");
});

test("表格:中文列按 cell 宽对齐(每行等宽,不错位)", () => {
  const md =
    "| 维度 | Go | Java |\n|---|---|---|\n| 并发模型 | goroutine | 线程 |\n| a | b | c |";
  const lines = renderMarkdown(md).split("\n").filter(Boolean);
  const widths = new Set(lines.map((l) => stringWidth(l)));
  expect(widths.size).toBe(1); // 关键:框线与每一行显示宽度完全一致
  expect(lines[0]!.startsWith("┌")).toBe(true);
  expect(lines[lines.length - 1]!.startsWith("└")).toBe(true);
});

test("表格:超宽列被压进终端宽度", () => {
  const long = "x".repeat(300);
  const out = renderMarkdown(`| a | b |\n|---|---|\n| ${long} | 1 |`);
  for (const l of out.split("\n").filter(Boolean)) {
    expect(stringWidth(l)).toBeLessThanOrEqual(80);
  }
});

test("有序列表:按 1. 2. 3. 编号(不被抹成圆点)", () => {
  const out = renderMarkdown("1. 甲\n2. 乙\n3. 丙");
  expect(out).toContain("1. 甲");
  expect(out).toContain("2. 乙");
  expect(out).toContain("3. 丙");
});

test("有序列表:start 非 1 时从 start 开始", () => {
  expect(renderMarkdown("3. 丙\n4. 丁")).toContain("3. 丙");
});

test("嵌套列表:子项比父项多缩进,且不泄漏记号", () => {
  const out = renderMarkdown("- 父\n  - 子\n");
  const lines = out.split("\n").filter((l) => l.trim());
  const parent = lines.find((l) => l.includes("父"))!;
  const child = lines.find((l) => l.includes("子"))!;
  expect(child.indexOf("子")).toBeGreaterThan(parent.indexOf("父"));
  expect(out).not.toContain("- 子");
});

test("列表项里的代码块:走 parse 不丢块级内容", () => {
  const out = renderMarkdown("- 步骤\n\n  ```bash\n  go build\n  ```\n");
  expect(out).toContain("go build");
  expect(out).not.toContain("```");
});

test("列表:不泄漏原始 - / ** 记号", () => {
  const out = renderMarkdown("- **项**");
  expect(out).toContain("项");
  expect(out).not.toContain("**");
  expect(out).not.toContain("- **");
});

test("引用块加 ▐ 前缀", () => {
  expect(renderMarkdown("> 引用")).toContain("引用");
});

test("流式安全:未闭合围栏/半截 markdown 不崩", () => {
  expect(() => renderMarkdown("## 半截")).not.toThrow();
  expect(() => renderMarkdown("```ts\nconst x =")) .not.toThrow();
  expect(() => renderMarkdown("[未闭合链接](https://")).not.toThrow();
  expect(() => renderMarkdown("")).not.toThrow();
});
test("表格:放不下的单元格折行而不是截断(内容不能变成 …)", () => {
  const long = "这是一段很长的中文说明文字用来把这一列撑爆需要折行显示";
  const out = renderMarkdown(`| 维度 | 说明 |\n|---|---|\n| a | ${long} |`);
  expect(out).not.toContain("…"); // 关键:不再用省略号吃掉内容
  const plain = out.replace(/[│┌┬┐├┼┤└┴┘─\s]/g, "");
  // 折行后把框线与空白剥掉,原文应完整还原
  expect(plain).toContain(long.slice(0, 10));
  expect(plain).toContain(long.slice(-10));
  // 每行仍与框线等宽
  const lines = out.split("\n").filter(Boolean);
  expect(new Set(lines.map((l) => stringWidth(l))).size).toBe(1);
});

test("表格:每条记录之间都有横线(单元格会折成多行,靠横线分辨记录)", () => {
  const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |");
  const seps = out.split("\n").filter((l) => l.startsWith("├")).length;
  expect(seps).toBe(3); // 表头下 1 条 + 数据行之间 2 条
});

test("表格:折行不丢样式(**加粗** 跨行不会漏色到框线上)", () => {
  const out = renderMarkdown(
    "| a |\n|---|\n| **一段需要折行的很长的加粗中文内容用来验证样式跨行** |",
  );
  for (const l of out.split("\n").filter((l) => l.startsWith("│"))) {
    // 每一行的样式自己闭合:行尾不能带着未关闭的 SGR 进下一行
    const opens = (l.match(/\x1b\[1m/g) ?? []).length;
    const closes = (l.match(/\x1b\[(0|22)m/g) ?? []).length;
    expect(closes).toBeGreaterThanOrEqual(opens);
  }
});
