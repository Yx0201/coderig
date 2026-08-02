// ===== Term:渲染 + 交互接缝 =====
//
// coderig 的 UI 分成两条路:TTY 下的 Ink TUI,和管道/CI(非 TTY)下的线性流式。
// 本文件定义两者共同的抽象 —— chat.ts 不再直接碰 process.stdout 或
// @clack/prompts,只对着这个接口说话。agent 循环 / 历史 / 工具执行 / tracer 全部
// 不感知渲染实现。
//
// 两条硬约束的设计落点:
//  1. content/reasoning 流式 → onContent / onReasoning 按 delta 增量喂给实现,由
//     TuiTerm 在底部 live 生长 / LinearTerm 直接写屏,都不是整块重绘。
//  2. 不影响 tracer 日志写入 → 本层只管"往终端画",tracer 的 persist 走文件,
//     与这里彻底解耦(见 observability/tracer.ts displaySink)。

import pc from "picocolors";
import { createLinearTerm } from "./linearTerm.ts";
import { TuiStore } from "./store.ts";
import { TuiTerm } from "./tuiTerm.ts";
import { startTui } from "./mount.tsx";
import { routeTracerToStore } from "./notice.ts";
import type { Tracer } from "../../observability/tracer.ts";

export type TermColor = "plain" | "dim" | "red" | "green" | "yellow" | "cyan";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

// 取消哨兵:取代 Clack 的 cancel symbol。promptInput/select 取消时返回它,
// chat.ts 用下方 isCancel() 判定(与现在 !p.isCancel() 语义对齐)。
export const CANCEL = Symbol("coderig.cancel");

export function isCancel(v: unknown): v is typeof CANCEL {
  return v === CANCEL;
}

// 一段流(一轮 sendMessages 的输入→输出)的交互外壳。start 在发请求前调一次,
// 之后按事件逐条喂;end/stop 在流完结时收尾。内部实现自行决定把还在"转"的
// spinner 定格成什么样,chat.ts 不关心这些字节。
export interface Term {
  // ===== 流式事件(每轮一次 start,事件逐条喂) =====
  start(): void; // 发请求前:启动"请求中" spinner
  onReasoning(text: string): void; // 增量思考(显示层按需呈现,无副作用)
  onContent(text: string): void; // 增量正文(流式写屏)
  onRetry(r: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }): void;
  onToolCallProgress(name: string | undefined, argsChars: number): void;
  end(): void; // 流正常完结:收尾 spinner
  stop(): void; // 离开本轮前的幂等兜底
  // → 实现层如 LinearTerm 把"思考中 spinner / atLineStart / progressActive / 定格
  //   '思考完成'"这套光标状态机藏在这里面,chat.ts 不再拥有它。

  // ===== 提示行 / 状态 =====
  notify(message: string, color?: TermColor): void; // 一次性提示(message 自带换行,原样输出)
  error(message: string): void; // 错误:红字 + 换行(对齐 renderError)
  setStatus(model: string, tokens?: { prompt: number; completion: number }): void; // 仅 TUI header 用,linear no-op
  showUser(text: string): void; // 用户消息块(TUI 显示在回卷;linear 的 Clack 已回显,no-op)
  shutdown(): void; // 结束整个会话时的收尾(linear no-op;TUI 卸载 Ink、恢复终端)

  // ===== 交互(返回 Promise,chat.ts 直接 await) =====
  promptInput(message?: string): Promise<string | typeof CANCEL>;
  confirm(message: string): Promise<boolean>; // true=批准 / false=拒绝
  select<T extends string = string>(
    title: string,
    options: readonly SelectOption<T>[],
  ): Promise<T | typeof CANCEL>;
}

// ---- 颜色工具(LinearTerm 复刻今日字节用) ----
export function paint(text: string, color?: TermColor): string {
  switch (color) {
    case "dim":
      return pc.dim(text);
    case "red":
      return pc.red(text);
    case "green":
      return pc.green(text);
    case "yellow":
      return pc.yellow(text);
    case "cyan":
      return pc.cyan(text);
    default:
      return text;
  }
}

// ---- TTY 门:真终端 + 没被 NO_TUI 关掉 → 起 TUI;否则回退线性流式 ----
export function createTerm(opts?: {
  // chat.ts 拥有 tracer 实例,传进来在 TUI 模式下把 4 条一次性提示行路由进 notice 块,
  // 否则它们会直写 stdout 污染 Ink 帧
  tracer?: Tracer;
}): Term {
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY) && process.env.NO_TUI !== "1";
  if (!tty) return createLinearTerm();

  const store = new TuiStore();
  const term = new TuiTerm(store);
  const ui = startTui(store);
  term.attachExit(() => (ui as { unmount(): void }).unmount()); // chat.ts 结束时恢复终端
  if (opts?.tracer) routeTracerToStore(opts.tracer, store);
  return term;
}