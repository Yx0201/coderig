// ===== TuiStore:渲染状态的可订阅存储 =====
//
// chat.ts(命令式 agent 循环)与 Ink 视图(声明式)之间的单向数据桥。
// chat.ts 只往里 append 数据;Ink 组件用 useSyncExternalStore 订阅,state 一变就重绘。
//
// 关键设计:append 来自 async generator(聊天流),不在 React 事件处理器里。
// React 里外部 store 一次 notify 会触发一次 reconcile;流式下同一 tick 会有大量
// append(chunk),每次 notify 就 reconcile 一次是浪费。所以这里做"一帧合并":
// 同一次宏任务里多次 append 只安排一次 notify(见 scheduleNotify)。

import type { SelectOption } from "./term.ts";

export type StaticBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; markdown: string } // 已完结的回答块(<Static> 渲染完整 markdown)
  | { kind: "thinking"; header: string; body: string; folded: boolean } // 折叠思考(回卷内只显示 header)
  | { kind: "tool"; name: string; result: string; ok: boolean; duration: number }
  | { kind: "notice"; text: string; color?: NoticeColor };

// notice 的语义色:chat.ts 传的 TermColor 直接透过来(⛔ 阻止要红、⊘ 压缩是灰)
export type NoticeColor = "red" | "yellow" | "green" | "cyan" | "dim";

// 底部活动状态:spinner 画什么、旁边写什么。idle = 没在等模型(不画 spinner)。
// 这是"当前正在发生什么"的唯一来源,取代之前把工具参数进度当 notice 灌进回卷的做法
export type ActivityKind =
  | "idle"
  | "waiting" // 已发请求,还没收到任何 token
  | "thinking" // 正在流 reasoning
  | "answering" // 正在流 content
  | "tool_args" // 模型正在流式生成工具参数
  | "tool_run"; // 工具在执行(慢工具)

export interface Activity {
  kind: ActivityKind;
  label?: string; // 工具名等附加信息
  chars?: number; // 已生成字符数(tool_args 用)
  startedAt: number; // 本活动开始的绝对时间戳,footer 显示已耗时
}

export interface ModalState<T extends string = string> {
  kind: "select" | "text";
  title: string; // select 的标题 / text 的提示
  options?: readonly SelectOption<T>[]; // select 用
  buffer?: string; // text 模态的输入草稿(UI 增量改它)
  cursorInd: number; // select 高亮下标(UI 改它)
  resolve: (value: string | undefined) => void;
  cancel?: () => void; // esc/Ctrl+C → undefined
}

export class TuiStore {
  private blocks: StaticBlock[] = [];
  private version = 0;
  private subscribers = new Set<() => void>();

  // live 流式区:当前轮未落定的 thinking/content(渲染层据此在底部 live 生长)
  private liveReasoning = "";
  private liveContent = "";

  // 头部状态(model/tokens),TuiTerm.setStatus 更新
  private status = { model: "", prompt: 0, completion: 0 };

  // 模态(Phase 7 用):chat.ts open 一个并 await resolve;渲染层 modal.tsx 画并调用
  private modal: ModalState | null = null;

  // 底部活动状态(spinner + 一行说明)
  private activity: Activity = { kind: "idle", startedAt: 0 };

  // Ink 是否还挂着。会话收尾时先 deactivate 再 unmount:之后 tracer 的汇总行、
  // "Bey~" 这类提示直接写 stdout —— 塞进 store 也没人再渲染了(会静默丢掉)
  private active = true;

  // ===== 一帧合并 =====
  private notifyScheduled = false;
  private scheduleNotify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.version++;
      this.subscribers.forEach((cb) => cb());
    });
  }

  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  getSnapshot = (): number => this.version;

  getBlocks(): StaticBlock[] {
    return this.blocks;
  }

  // ===== 静态块(<Static> 只渲染已落定的块) =====
  // 注意:必须用"新建数组再赋值"而不是原地 push —— <Static> 靠 items 引用变化判断有新内容
  // (其 useMemo([items,index]) 依赖 items 引用,原地 push 引用不变 → 新块永远不被渲染)
  private commitBlock(b: StaticBlock) {
    this.blocks = [...this.blocks, b];
    this.scheduleNotify();
  }
  pushUser(text: string) {
    this.commitBlock({ kind: "user", text });
  }
  pushAssistant(markdown: string) {
    this.commitBlock({ kind: "assistant", markdown });
  }
  pushThinking(header: string, body: string, folded = true) {
    this.commitBlock({ kind: "thinking", header, body, folded });
  }
  pushTool(name: string, result: string, ok: boolean, duration: number) {
    this.commitBlock({ kind: "tool", name, result, ok, duration });
  }
  // notice 的文本来自 chat.ts / tracer,带着为线性输出准备的前后换行(如 "\n⛔ …\n")。
  // Ink 的每个块本身就独占行,原样塞进去会多出空行 → 统一剥掉首尾换行;
  // 剥完是空串就整条丢弃(chat.ts 用 notify("") 做线性模式的分隔,TUI 不需要)
  pushNotice(text: string, color?: NoticeColor) {
    const t = text.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!t) return;
    if (!this.active) {
      process.stdout.write(t + "\n"); // Ink 已卸载:直接落终端,别静默丢掉
      return;
    }
    this.commitBlock({ kind: "notice", text: t, color });
  }

  // ===== live 流式区(块未完结前的增量) =====
  appendReasoning(delta: string) {
    this.liveReasoning += delta;
    this.scheduleNotify();
  }
  appendContent(delta: string) {
    this.liveContent += delta;
    this.scheduleNotify();
  }
  // 本轮流完结:取走 live,清空留给下一轮
  takeLive(): { reasoning: string; content: string } {
    const r = { reasoning: this.liveReasoning, content: this.liveContent };
    this.liveReasoning = "";
    this.liveContent = "";
    return r;
  }
  getLive(): { reasoning: string; content: string } {
    return { reasoning: this.liveReasoning, content: this.liveContent };
  }

  // ===== 头部状态 =====
  setStatus(model: string, tokens?: { prompt: number; completion: number }) {
    this.status.model = model;
    if (tokens) {
      this.status.prompt = tokens.prompt;
      this.status.completion = tokens.completion;
    }
    this.scheduleNotify();
  }
  getStatus() {
    return { ...this.status };
  }
  // ===== 底部活动状态 =====
  // 同 kind + 同 label 的重复设置不重置 startedAt(否则工具参数进度每来一个 chunk
  // 计时就被清零,"已耗时"永远显示 0.0s)
  setActivity(kind: ActivityKind, extra?: { label?: string; chars?: number }) {
    const same = this.activity.kind === kind && this.activity.label === extra?.label;
    this.activity = {
      kind,
      label: extra?.label,
      chars: extra?.chars,
      startedAt: same && this.activity.startedAt ? this.activity.startedAt : Date.now(),
    };
    this.scheduleNotify();
  }
  getActivity(): Activity {
    return this.activity;
  }

  // ===== 生命周期 =====
  deactivate() {
    this.active = false;
  }
  isActive(): boolean {
    return this.active;
  }
  // 强制重绘(计时器等外部驱动用)
  bump() {
    this.scheduleNotify();
  }

  // ===== 模态 =====
  getModal(): ModalState | null {
    return this.modal;
  }
  // 打开一个模态,返回 Promise。渲染层画出模态,用户操作通过 resolveModal/cancelModal 终结它。
// 所有交互(promptInput/select/confirm)统一成一类;TuiTerm 负责把返回的 value 映射成语义。
openModal<T extends string>(
  kind: "select" | "text",
  opts: { title: string; options?: readonly SelectOption<T>[] },
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    this.modal = {
      kind,
      title: opts.title,
      options: opts.options,
      buffer: kind === "text" ? "" : undefined,
      cursorInd: 0,
      resolve: (v) => resolve(v as T),
      cancel: () => resolve(undefined),
    };
    this.scheduleNotify();
  });
}
// UI 改了模态内部状态(cursorInd/buffer)后调它,仅重绘
refreshModal() {
  this.scheduleNotify();
}
resolveModal(value: string | undefined) {
  const m = this.modal;
  this.modal = null;
  this.scheduleNotify();
  m?.resolve(value);
}
cancelModal() {
  const m = this.modal;
  this.modal = null;
  this.scheduleNotify();
  m?.cancel?.();
}
hasModal(): boolean {
  return this.modal !== null;
}
}