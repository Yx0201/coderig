// ===== markdown → ANSI:给"已完结历史块"做完整着色渲染 =====
//
// 用途:一块 content 落定后,渲染成带 ANSI 色的串,交给 <Static> 推进真实终端回卷
// (回卷按屏幕原生宽度折行,这里不需要也不应该手动 wrap)。
// live 流式区不经过这里——它按纯文本折行(见 layout.ts),格式化在块落定时一次性完成。
//
// 三条踩过的坑,改动时别退回去:
//  1. 块级 renderer(paragraph/listitem/blockquote/tablecell/heading)必须用
//     `this.parser.parseInline(tokens)` 渲染**内联 token**,而不是直接用 token.text ——
//     否则 `**加粗**` 会原样漏出来。
//  2. 列表项/引用里可能嵌**块级** token(嵌套列表、代码块),那种要走 `this.parser.parse`
//     再整段缩进;用 parseInline 会抛,退化成纯文本就丢了层级。
//  3. 表格/代码框的框线宽度必须按**终端列宽 + cell 宽**算。写死长度在中文表格里必然错位
//     (中文占 2 列),这正是重构后表格看起来"歪"的原因。

import pc from "picocolors";
import { Marked, type RendererObject, type Tokens, type Token } from "marked";
import { createLowlight, common } from "lowlight";
import { stringWidth, visibleWidth, wrapStyled } from "./layout.ts";
import { termWidth } from "./width.ts";

const lowlight = createLowlight(common);

// hljs scope → 颜色。取通用终端色,保证深/浅底色都看得清。
const SCOPE_STYLE: Record<string, (s: string) => string> = {
  keyword: pc.cyan,
  "keyword flow": pc.cyan,
  control: pc.cyan,
  string: pc.green,
  "string regexp": pc.green,
  number: pc.yellow,
  title: pc.blue,
  "title function": pc.blue,
  function: pc.blue,
  tag: pc.magenta,
  attribute: pc.yellow,
  built_in: pc.yellow,
  type: pc.blue,
  literal: pc.cyan,
  class: pc.blue,
  variable: pc.cyan,
  comment: pc.dim,
  meta: pc.dim,
  default: (s) => s,
};

// 量"显示宽度"必须先剥 ANSI:SGR 序列不占终端列,算进去表格会短一截(实现在 layout.ts)
const displayWidth = visibleWidth;

// marked 的 text/codespan token 是 HTML 转义过的(&amp; &lt; &#39;…)。
// 终端不是浏览器,得还原成字面量,否则代码里的 `a && b` 会显示成 `a &amp;&amp; b`
function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// 用 lowlight 给一段代码块上色(lang 未知/缺失时自动检测)
function highlightCode(code: string, lang?: string): string {
  let tree;
  try {
    tree = lang ? lowlight.highlight(lang, code) : lowlight.highlightAuto(code);
  } catch {
    return code; // 高亮失败退回纯文本,不崩
  }
  return highlightTree(tree);
}

// 把 lowlight AST 线性化:children 里 element→text 交替,逐层累积 scope,套上对应颜色
function highlightTree(tree: any): string {
  let out = "";
  const stack: string[] = [];
  const visit = (node: any) => {
    if (node.type === "text") {
      const scope = stack[stack.length - 1];
      const style = (scope && SCOPE_STYLE[scope]) || ((s: string) => s);
      out += style(node.value);
      return;
    }
    if (node.properties?.className?.length) {
      stack.push(String(node.properties.className[0]));
    }
    for (const c of node.children ?? []) visit(c);
    if (node.properties?.className?.length) stack.pop();
  };
  visit(tree);
  return out;
}

// 有 tokens → 先跑内联 token 渲染(strong/em/codespan/link);否则兜底原文文本
type Inlineable = { tokens?: Token[] | undefined; text?: string };
function il(this: any, t: Inlineable): string {
  const parser = this?.parser;
  if (t.tokens && t.tokens.length > 0 && parser?.parseInline) {
    try {
      return parser.parseInline(t.tokens);
    } catch {
      // 容器里混了块级 token,交给下面的 blockOrInline 处理;这里兜住不崩
    }
  }
  return unesc(t.text ?? "");
}

// 块级 token 集合:出现在列表项/引用里时要走 parser.parse(整段渲染)而不是 parseInline
const BLOCK_TYPES = new Set([
  "paragraph",
  "list",
  "code",
  "blockquote",
  "heading",
  "table",
  "hr",
  "space",
]);

// 容器内容渲染:含块级 token 走 parse,纯内联走 parseInline
function blockOrInline(this: any, tokens: Token[] | undefined, fallback = ""): string {
  const parser = this?.parser;
  if (!tokens || tokens.length === 0) return fallback;
  const hasBlock = tokens.some((t) => BLOCK_TYPES.has(t.type));
  try {
    return hasBlock ? parser.parse(tokens) : parser.parseInline(tokens);
  } catch {
    return fallback;
  }
}

// 每行加固定前缀/缩进(首行前缀可与后续不同:列表项 "• " + 后续对齐空格)
function prefixLines(text: string, first: string, rest: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.map((l, i) => (i === 0 ? first + l : rest + l)).join("\n");
}

// ===== 代码块 =====
// 不画右边框:代码行长度参差、还可能被终端原生折行,右边框必然对不齐(那才是"歪"的来源)。
// 改成上下两条按终端宽度对齐的横线 + 语言标注,视觉上仍是一个块。
function renderCode(code: string, lang?: string): string {
  const body = code.replace(/\n+$/, "");
  if (!body.trim()) return ""; // 空围栏不画空框(模型偶尔吐 ```\n```)
  const w = Math.min(termWidth() - 2, 100);
  const label = lang ? ` ${lang} ` : " code ";
  const rule = pc.dim("─".repeat(Math.max(0, w - stringWidth(label) - 2)));
  const top = pc.dim("──") + pc.dim(pc.bold(label)) + rule;
  const bottom = pc.dim("─".repeat(w));
  const highlighted = highlightCode(body, lang);
  const lines = highlighted.split("\n").map((l) => `  ${l}`);
  return `\n${top}\n${lines.join("\n")}\n${bottom}\n`;
}

// ===== 表格 =====
// 列宽 = 各列最宽 cell(按 cell 宽,不是 length),再按终端宽度等比收窄;放不下的 cell 折行。
// 中文表格全靠这一步才不错位。
const MIN_COL = 4;

function renderTable(header: string[], rows: string[][]): string {
  const cols = header.length;
  if (cols === 0) return "";
  const all = [header, ...rows];
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(...all.map((r) => displayWidth(r[c] ?? ""))),
  );
  // 边框开销:每列 "│ " + " " = 3,最后再一个 "│"
  const budget = termWidth() - (cols * 3 + 1);
  const widths = fitWidths(natural, Math.max(cols * MIN_COL, budget));

  const line = (l: string, mid: string, r: string) =>
    pc.dim(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r);
  const bar = pc.dim("│");

  // 一行 = 各列折行后的若干显示行(行高取最高的那列)。刻意不截断:
  // 截断会把内容变成 "…" 直接看不到,折行只是多占几行,信息是全的
  const row = (cells: string[], bold: boolean): string[] => {
    const wrapped = widths.map((w, i) => {
      const raw = cells[i] ?? "";
      const ls = wrapStyled(bold ? pc.bold(raw) : raw, w);
      return ls.length ? ls : [""];
    });
    const height = Math.max(...wrapped.map((ls) => ls.length));
    return Array.from({ length: height }, (_, r) =>
      bar +
      wrapped
        .map((ls, i) => {
          const cell = ls[r] ?? "";
          const pad = " ".repeat(Math.max(0, widths[i]! - displayWidth(cell)));
          return ` ${cell}${pad} `;
        })
        .join(bar) +
      bar,
    );
  };

  // 每行之间都画横线(满格线):单元格会折成多行,没有横线就分不清哪几行属于同一条记录
  const out = [line("┌", "┬", "┐"), ...row(header, true), line("├", "┼", "┤")];
  rows.forEach((r, i) => {
    if (i > 0) out.push(line("├", "┼", "┤"));
    out.push(...row(r, false));
  });
  out.push(line("└", "┴", "┘"));
  return `\n${out.join("\n")}\n`;
}

// 把自然列宽压进预算:从最宽的列开始削,直到总和达标或都到下限
export function fitWidths(natural: number[], budget: number): number[] {
  const w = natural.map((n) => Math.max(MIN_COL, n));
  let total = w.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < w.length; i++) if (w[i]! > w[widest]!) widest = i;
    if (w[widest]! <= MIN_COL) break; // 都到下限了,再削也没意义(让终端原生折行)
    w[widest] = w[widest]! - 1;
    total--;
  }
  return w;
}

// ===== 自定义 renderer:把标记语法输出为 ANSI 文本(不产 HTML) =====
const renderer: RendererObject = {
  // text token 是转义过的,还原成字面量(默认 renderer 会把 &amp; 原样吐出来)
  text(t: Tokens.Text | Tokens.Escape) {
    const anyT = t as any;
    if (anyT.tokens?.length) return il.call(this, anyT);
    return unesc(t.text ?? "");
  },
  heading(t: Tokens.Heading) {
    const body = il.call(this, t);
    const text = `${"#".repeat(t.depth)} ${body}`;
    return "\n" + (t.depth <= 2 ? pc.bold(pc.cyan(text)) : pc.bold(text)) + "\n";
  },
  paragraph(t: Tokens.Paragraph) {
    return il.call(this, t) + "\n";
  },
  strong(t: Tokens.Strong) {
    return pc.bold(il.call(this, t));
  },
  em(t: Tokens.Em) {
    return pc.italic(il.call(this, t));
  },
  del(t: Tokens.Del) {
    return pc.strikethrough(il.call(this, t));
  },
  // 行内码:反显块(pc.inverse)在深色终端里是一坨白底,读着累;用青色更贴近编辑器观感
  codespan(t: Tokens.Codespan) {
    return pc.cyan(unesc(t.text));
  },
  code(t: Tokens.Code) {
    return renderCode(t.text, t.lang?.split(/\s+/)[0] || undefined);
  },
  list(t: Tokens.List) {
    let out = "";
    // 有序列表要按 start 递增编号(之前一律 "•",1./2./3. 全被抹平)
    let n = typeof t.start === "number" && t.start > 0 ? t.start : 1;
    for (const it of t.items) {
      const mark = it.task ? (it.checked ? "☑ " : "☐ ") : t.ordered ? `${n++}. ` : "• ";
      const body = blockOrInline.call(this, it.tokens, unesc(it.text ?? "")).trimEnd();
      // 续行按标记宽度对齐;嵌套列表因此天然缩进一层
      out += prefixLines(body, `  ${mark}`, `  ${" ".repeat(stringWidth(mark))}`) + "\n";
    }
    return `\n${out}`;
  },
  blockquote(t: Tokens.Blockquote) {
    const body = blockOrInline.call(this, t.tokens, unesc(t.text ?? ""));
    return prefixLines(body, pc.dim("▏ "), pc.dim("▏ ")) + "\n";
  },
  link(t: Tokens.Link) {
    return pc.cyan(il.call(this, t)) + pc.dim(` (${t.href ?? ""})`);
  },
  image(t: Tokens.Image) {
    const alt = il.call(this, t);
    return pc.dim(alt ? `[img] ${alt}` : "[img]");
  },
  html(t: Tokens.HTML | Tokens.Tag) {
    // 剥掉标签、不逐字吐 HTML
    return unesc((t.text ?? "").replace(/<\/?[^>]*>/g, ""));
  },
  br() {
    return "\n";
  },
  hr() {
    return pc.dim("─".repeat(Math.min(termWidth() - 2, 60))) + "\n";
  },
  table(t: Tokens.Table) {
    const cell = (c: Tokens.TableCell) => il.call(this, c);
    return renderTable(t.header.map(cell), t.rows.map((r) => r.map(cell)));
  },
};

const parser = new Marked({ renderer, gfm: true, breaks: true });

// 全文渲染成 ANSI(供 <Static> 历史块)。首尾多余空行收掉:块与块的间距由渲染层管
export function renderMarkdown(md: string): string {
  const out = parser.parse(md) as string;
  return out.replace(/^\n+/, "").replace(/\n+$/, "");
}
