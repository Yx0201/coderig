// ===== 纯布局原语:cell 宽 + 折行 + 可滚动内容视图 =====
//
// TUI 底部"live 流式区"是有界的:超过高度要在区内滚动。这块是纯函数/纯类,
// 不碰进程/React(Ink 视图通过它取每一帧要画哪几行)。
//
// 为什么要自己的 cell 宽而不是字符串长度:string.length 数的是码元,不是终端列。
// 中文/emoji 是双宽(占 2 列),combining 是零宽;按 length 折行会错位、切碎中文。

// 判断单个码点占几个终端列(宽/窄/零宽)
export function cellWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  // 零宽:combining 记号(多数变音符)、零宽连接符、emoji 变体选择符(U+FE0F 只改样式不占列)
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200c && cp <= 0x200f) ||
    cp === 0xfe0f ||
    cp === 0x20e3
  ) {
    return 0;
  }
  // BMP 里散落的"宽符号":⏳⌛⭐✅❌ 这类。它们不在 CJK 段里,漏掉会让含 emoji 的
  // 行宽算少 1 格 —— 表格/框线就是这么错位的
  if (
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  ) {
    return 2;
  }
  // 全宽/宽:CJK、假名、韩文、全角符号、emoji 等
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) || // 含 CJK 统一表意
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容表单
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) // emoji(含 🀄🃏 等低段)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += cellWidth(ch);
  return w;
}

// 把文本按给定宽度(格)折行。绝不从双宽字符中间切开:前后码元宽 > 可容纳时会先换行。
// 返回 PLACE text 的"显示行"数组(不含 ANSI——live 区用纯文本,历史块走回卷原生折行)。
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  let lineCells = 0;
  const push = () => {
    if (line.length) out.push(line);
    line = "";
    lineCells = 0;
  };
  for (const ch of text) {
    if (ch === "\n") {
      push();
      continue;
    }
    if (ch === "\t") {
      // tab 推进到下一个 4 格边界
      const spaces = 4 - (lineCells % 4);
      line += " ".repeat(spaces);
      lineCells += spaces;
      continue;
    }
    const w = cellWidth(ch);
    if (lineCells + w > width) {
      push(); // 当前行放不下,先换行再放
    }
    line += ch;
    lineCells += w;
  }
  push();
  return out;
}

// 按终端列宽截断(超出补 "…")。按 cell 宽算,不会把中文切半;max<=0 返回空串。
// 必须认 ANSI:表格单元格里的内容已经上色(markdown 渲染的产物),把 "\x1b[36m" 当普通
// 字符会①宽度多算 5 格(列错位)②从序列中间切断,残字节被终端吞掉后面的正文。
// 序列本身零宽原样保留;真截断了就补一个 reset,否则颜色/粗体会漏到后面的框线上。
const SGR = /^\x1b\[[0-9;]*m/;
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  let styled = false;
  let i = 0;
  while (i < text.length) {
    const m = SGR.exec(text.slice(i));
    if (m) {
      out += m[0];
      styled = true;
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = cellWidth(ch);
    if (w + cw > max - 1) break; // 留 1 格给省略号
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + "…" + (styled ? "\x1b[0m" : "");
}

// 去掉 ANSI 后的显示宽度(样式序列不占列)
export function visibleWidth(text: string): number {
  return stringWidth(text.replace(/\x1b\[[0-9;]*m/g, ""));
}

// 带样式折行:把含 ANSI 的文本折成不超过 width 格的多行,样式跨行不断。
// 表格单元格要的是"折行而不是截断"(截断=信息丢失,用户看不到完整内容)。
// 三个要点:①SGR 序列零宽,不能算进列宽也不能被切断;②换行时先 reset,下一行把仍生效的
// 样式重新打开,否则颜色会漏到框线上、或者下半行没了颜色;③英文单词整体搬到下一行
// (CJK 逐字可断,ASCII 单词断在中间很难读),单词本身超过一列宽时才硬切。
export function wrapStyled(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  const active: string[] = []; // 当前生效的 SGR(换行后要重新打开)
  let line = "";
  let cells = 0;

  // 行尾空格不留(表格靠自己补 pad,留着只会让"看起来的宽度"和框线打架)
  const trimEnd = (s: string) => s.replace(/ +(?=(?:\x1b\[[0-9;]*m)*$)/, "");
  const flush = () => {
    out.push(active.length ? trimEnd(line) + "\x1b[0m" : trimEnd(line));
    line = active.join("");
    cells = 0;
  };
  const put = (s: string, w: number) => {
    line += s;
    cells += w;
  };

  for (const tok of tokenizeStyled(text)) {
    if (tok.w === 0) {
      // 样式序列:原样带上,并记录/清空"当前生效样式"
      line += tok.s;
      if (/^\x1b\[0?m$/.test(tok.s)) active.length = 0;
      else active.push(tok.s);
      continue;
    }
    if (cells + tok.w > width) {
      if (tok.s === " ") {
        flush(); // 行尾空格吃掉,不带到下一行开头
        continue;
      }
      if (tok.w > width) {
        // 比一整列还长的单词/路径:只能硬切
        for (const ch of tok.s) {
          const cw = cellWidth(ch);
          if (cells + cw > width) flush();
          put(ch, cw);
        }
        continue;
      }
      flush();
    }
    put(tok.s, tok.w);
  }
  out.push(active.length ? trimEnd(line) + "\x1b[0m" : trimEnd(line));
  return out;
}

// 不能出现在行首的标点(中日排版的"禁则"):折行时跟着上一个字走
const NO_BREAK_BEFORE = new Set([
  "。", "，", "、", "；", "：", "！", "？", "）", "】", "》", "」", "』", "〉", "｝",
  "…", "·",
]);

// 切成"样式序列 / 空格 / 单个宽字符 / 一串窄字符(英文单词)"四类,折行以此为最小单位
function tokenizeStyled(text: string): { s: string; w: number }[] {
  const toks: { s: string; w: number }[] = [];
  let word = "";
  const flushWord = () => {
    if (word) {
      toks.push({ s: word, w: stringWidth(word) });
      word = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const m = SGR.exec(text.slice(i));
    if (m) {
      flushWord();
      toks.push({ s: m[0], w: 0 });
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    if (ch === "\n") {
      // 单元格里的换行:当成空格(表格行高由折行决定)
      flushWord();
      toks.push({ s: " ", w: 1 });
      continue;
    }
    if (ch === " " || cellWidth(ch) === 2) {
      const cw = cellWidth(ch);
      // 禁则处理:句读类标点不能落在行首(折行折出一行孤零零的"。"很难看),
      // 直接粘到前一个 token 上跟着它一起换行
      const prev = toks[toks.length - 1];
      if (NO_BREAK_BEFORE.has(ch) && !word && prev && prev.w > 0) {
        prev.s += ch;
        prev.w += cw;
        continue;
      }
      flushWord();
      toks.push({ s: ch, w: cw });
      continue;
    }
    word += ch;
  }
  flushWord();
  return toks;
}

// 取文本的末 n 个显示行(live 流式区只画"最近若干行":footer 高度有限,
// 整段 reasoning 全塞进帧会把输入行顶出屏幕、还让每帧重绘越来越贵)
export function tailLines(text: string, width: number, n: number): string[] {
  const rows = wrapText(text, width);
  return rows.length <= n ? rows : rows.slice(rows.length - n);
}

// 可滚动内容视图:维护"已追加的所有行 + 可见窗口 top 偏移"。用于 live 流式区。
// 语义:追加后若在"跟随底部"态则窗口自动贴底;用户上滚则冻结,item 不再跟着滚;
// 滚到底立即恢复跟随。
export class ContentView {
  rows: string[] = []; // 全部已追加的显示行(纯文本)
  top = 0; // 可见窗口首行下标
  height: number; // 可见区行数
  width: number; // 折行宽度
  followBottom = true;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  // 尺寸变了:重算跟随贴底 + clamp 当前 top
  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    if (this.followBottom) {
      this.top = Math.max(0, this.rows.length - this.height);
    } else {
      this.top = Math.max(0, Math.min(this.top, this.rows.length - this.height));
    }
  }

  // 追加一段文本:折行后入 rows,跟随态贴底
  append(text: string) {
    const newRows = wrapText(text, this.width);
    this.rows.push(...newRows);
    if (this.followBottom) this.top = Math.max(0, this.rows.length - this.height);
  }

  // 追加一行"已完成"横线/空行(保持块与块之间的节奏)
  blank() {
    this.append("\n");
  }

  clear() {
    this.rows = [];
    this.top = 0;
  }

  // 当前可视行(供渲染)
  visible(): string[] {
    return this.rows.slice(this.top, this.top + this.height);
  }

  atBottom(): boolean {
    return this.top >= this.rows.length - this.height;
  }

  // 用户上滚:冻结跟随
  scroll(delta: number) {
    this.followBottom = false;
    const maxTop = Math.max(0, this.rows.length - this.height);
    this.top = Math.max(0, Math.min(this.top + delta, maxTop));
    if (this.top >= maxTop) this.followBottom = true; // 滚到底 → 恢复跟随
  }

  scrollToBottom() {
    this.followBottom = true;
    this.top = Math.max(0, this.rows.length - this.height);
  }

  scrollToTop() {
    this.followBottom = false;
    this.top = 0;
  }

  // 滚动条信息:可见区在全部内容中的比例与位置(renderer 据此画条)
  scrollbarInfo(): { offset: number; fraction: number } | null {
    const total = this.rows.length;
    if (total <= this.height) return null; // 未溢出无需滚动条
    const end = Math.min(total, this.top + this.height);
    // offset:条顶位置占总长度的比例; fraction:条的长度占全长比例
    const fraction = this.height / total;
    const offset = this.top / total;
    return { offset, fraction };
  }
}