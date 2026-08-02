// ===== LinearTerm:管道 / 非 TTY 下的线性流式渲染 =====
//
// 把 chat.ts 里原有的"裸 process.stdout.write + renderLoading spinner + @clack
// 交互 + 思考态状态机"整体收编进这一个类。目标是 **字节级复刻** 改造前的输出:
// 管道、CI、或任何非交互终台下,coderig 的行为与今天完全一致,测试/日志不受影响。
//
// 从这里并不存在 TUI:它是退化路径。后续 TuiTerm 走另一套(store + Ink),两者通过
// term.ts 的接口切换,互不感知。

import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Term, TermColor, SelectOption } from "./term.ts";
import { CANCEL, paint } from "./term.ts";
import { renderLoading, renderError } from "../render.ts";

// 清当前行:对齐 render.ts 里的常量(ANSI 整行擦除,不是打空格)
const CLEAR_LINE = "\x1b[2K\r";

export type LinearLoader = ReturnType<typeof renderLoading>;

export class LinearTerm implements Term {
  // 注入式 loader:测试可传 fake(确定性断言状态机);生产默认 renderLoading。
  // spinner 的真实字节输出由 render.test.ts 覆盖,这里品种保的是状态机顺序
  private loading: LinearLoader;
  // 思考态状态机(对话正文的"当前轮"光标管理):
  //  - thinkingShown: "正在思考…" spinner 是否占着一行(只在思考时开)
  //  - atLineStart:    光标是否停在空行行首(工具进度决定要不要先补 \n)
  //  - progressActive: 工具参数进度是否已独占一行(之后用 \r 原地刷新)
  private thinkingShown = false;
  private atLineStart = true;
  private progressActive = false;

  constructor(loader: LinearLoader = renderLoading()) {
    this.loading = loader;
  }

  // 思考阶段收尾:把 spinner 行定格成"思考完成"并换行。任何会产生可见输出的事件
  // (content / 工具进度 / 重试提示)之前都必须先调它,否则新输出把还在转的 spinner
  // 行挤进滚动历史,留下"⠹ 正在思考…"残影。
  private finishThinking() {
    if (!this.thinkingShown) return;
    this.thinkingShown = false;
    this.loading.done("思考完成"); // 内部:清行 + 写文案 + 换行
    this.atLineStart = true;
  }

  // ===== 流式事件 =====
  start(): void {
    this.loading.start();
  }

  onReasoning(_text: string): void {
    // 思考原文不打印(完整原文已由 llmRaw 事件落盘到 tracer,终端隐藏不丢数据),
    // 只进入/维持"正在思考…" spinner。同时复位进度行(新的思考段到来 = 上一段进度结束)
    this.progressActive = false;
    if (!this.thinkingShown) {
      this.thinkingShown = true;
      this.loading.setMessage("正在思考…"); // spinner 本就在转(start 在发请求前)
      this.loading.start(); // 幂等:兜住"首个事件前 spinner 已被停掉"的路径
    }
  }

  onContent(text: string): void {
    this.finishThinking();
    this.loading.stop();
    this.progressActive = false;
    process.stdout.write(text);
    // 正文可能自带换行结尾,据此更新光标位置(供工具进度决定要不要补 \n)
    this.atLineStart = text.endsWith("\n");
  }

  onRetry(r: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }): void {
    this.finishThinking();
    this.loading.stop();
    process.stdout.write(
      pc.dim(
        `\n⟳ 请求失败(${(r.reason ?? "").slice(0, 120)}),${(r.delayMs / 1000).toFixed(1)}s 后重试(${r.attempt}/${r.maxAttempts})\n`,
      ),
    );
    this.progressActive = false;
    this.atLineStart = true;
    // 重试 = 重新发一轮:思考态已收尾,spinner 重新转起来表示"在等退避"
    this.loading.setMessage("");
    this.loading.start();
  }

  onToolCallProgress(name: string | undefined, argsChars: number): void {
    // 这是"产生可见输出"的事件:先给思考阶段收尾 + 停 spinner(否则进度行会被
    // 还在转的 spinner 挤进历史,留下一闪而过的"⠹ 正在思考…")
    this.finishThinking();
    this.loading.stop();
    // 首次进度事件独占一行:光标不在行首才补 \n(思考收尾已换行就不再补),之后用
    // 整行擦除 + \r 原地刷新
    if (!this.progressActive) {
      if (!this.atLineStart) process.stdout.write("\n");
      this.progressActive = true;
    }
    process.stdout.write(
      CLEAR_LINE +
        pc.dim(`⏳ 正在生成 ${name ?? "工具调用"} 的参数… ${argsChars} 字符`),
    );
    this.atLineStart = false;
  }

  end(): void {
    this.finishThinking();
  }

  stop(): void {
    this.loading.stop(); // 幂等:已 done/已 stop 时 no-op
  }

  // ===== 提示行 / 状态 =====
  notify(message: string, color?: TermColor): void {
    // message 自带换行(调用方保证),原样输出;必要时包颜色
    process.stdout.write(color ? paint(message, color) : message);
  }

  error(message: string): void {
    renderError(message);
  }

  setStatus(): void {
    // 线性模式没有固定 header,no-op
  }

  showUser(): void {
    // 线性模式下 Clack 的输入框已回显用户输入,这里不重复打印
  }

  shutdown(): void {
    // 线性模式无 Ink 实例需要卸载
  }

  // ===== 交互 =====
  async promptInput(): Promise<string | typeof CANCEL> {
    const r = await p.text({ message: "请输入信息" });
    return p.isCancel(r) ? CANCEL : r;
  }

  async confirm(message: string): Promise<boolean> {
    const r = await p.confirm({ message });
    return !p.isCancel(r) && r === true; // 同评审 P0-2:点"否"是 false,不能把 !isCancel() 当成"是"
  }

  async select<T extends string = string>(
    title: string,
    options: readonly SelectOption<T>[],
  ): Promise<T | typeof CANCEL> {
    // Clack 要可变数组,读侧 readonly 转成一份新数组,并用其声明类型锚定
    const clackOptions = options.map((o) => ({
      value: o.value,
      label: o.label,
    })) as unknown as Parameters<typeof p.select>[0]["options"];
    const choice = await p.select({ message: title, options: clackOptions });
    return p.isCancel(choice) ? CANCEL : (choice as T);
  }
}

// createTerm 接口需要按名实例化(与 term.ts 解耦),这里只导出类,装配在 term.ts。
export function createLinearTerm(): Term {
  return new LinearTerm();
}