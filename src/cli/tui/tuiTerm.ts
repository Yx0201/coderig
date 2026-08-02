// ===== TuiTerm:Term 的 TUI 实现(驱动 TuiStore → Ink) =====
//
// chat.ts 只对着 Term 接口说话;TuiTerm 把每条动作翻译成对 TuiStore 的 append /
// 模态 open。非交互(stream/notify/status)走 store 的 live / 静态块;交互
// (promptInput/select/confirm)走 store 的模态(渲染层 modal.tsx 画 + useInput 终结)。

import type { Term, TermColor, SelectOption } from "./term.ts";
import { CANCEL } from "./term.ts";
import type { TuiStore } from "./store.ts";

export class TuiTerm implements Term {
  private store: TuiStore;
  private exitHook: (() => void) | null = null;
  private roundStart = 0; // 本轮流开始的时间戳,thinking 折叠行显示"思考了多久"

  constructor(store: TuiStore) {
    this.store = store;
  }

  // createTerm 用它挂上"会话结束 → 卸载 Ink 恢复终端"的收尾
  attachExit(fn: () => void) {
    this.exitHook = fn;
  }

  // ===== 流式 =====
  // 活动状态就是 TUI 的 spinner 驱动:start=等首个 token,reasoning/content 到来后
  // 切成"思考中/回答中"。footer 据此画转圈 + 已耗时,不再往回卷灌进度行
  start(): void {
    this.roundStart = Date.now();
    this.store.setActivity("waiting");
  }
  onReasoning(text: string): void {
    this.store.setActivity("thinking");
    this.store.appendReasoning(text);
  }
  onContent(text: string): void {
    this.store.setActivity("answering");
    this.store.appendContent(text);
  }
  onRetry(r: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }): void {
    this.store.pushNotice(
      `⟳ 请求失败(${(r.reason ?? "").slice(0, 120)}),${(r.delayMs / 1000).toFixed(1)}s 后重试(${r.attempt}/${r.maxAttempts})`,
      "yellow",
    );
    // 重试 = 重新等一轮响应:活动状态回到 waiting,spinner 继续转(否则退避期间界面像死了)
    this.store.setActivity("waiting");
  }
  onToolCallProgress(name: string | undefined, argsChars: number): void {
    // 参数流式生成是"瞬时状态"不是历史:进 footer 的活动行,不再每次落一条 notice
    // (之前每个进度事件一条 notice,回卷里刷出一串"正在生成…0 字符"的噪音)
    this.store.setActivity("tool_args", { label: name ?? "工具调用", chars: argsChars });
  }
  // 本轮流完结:live 取走 → 折叠 thinking + assistant 进 Static(历史可回卷)
  end(): void {
    const live = this.store.takeLive();
    if (live.reasoning) {
      const sec = this.roundStart ? ((Date.now() - this.roundStart) / 1000).toFixed(1) : "?";
      // header 里不再自带 🤔:图标由渲染层加,两边都写会出现"🤔 🤔 thinking"
      this.store.pushThinking(`thinking · ${live.reasoning.length} 字 · ${sec}s`, live.reasoning, true);
    }
    if (live.content.trim()) {
      this.store.pushAssistant(live.content);
    }
    this.store.setActivity("idle");
  }
  stop(): void {
    // 幂等兜底:离开本轮时 spinner 一定不能还在转
    this.store.setActivity("idle");
  }

  // ===== 提示 / 状态 =====
  notify(message: string, color?: TermColor): void {
    // "plain" 不是 notice 的色(Ink 没有这个色名),按默认灰处理
    this.store.pushNotice(message, color && color !== "plain" ? color : undefined);
  }
  error(message: string): void {
    this.store.pushNotice(`✗ ${message}`, "red"); // 对齐 renderError 的红字语义
  }
  setStatus(model: string, tokens?: { prompt: number; completion: number }): void {
    this.store.setStatus(model, tokens);
  }

  // ===== 交互(模态) =====
  async promptInput(): Promise<string | typeof CANCEL> {
    const v = await this.store.openModal<string>("text", { title: "" });
    return v === undefined ? CANCEL : v;
  }
  async confirm(message: string): Promise<boolean> {
    const v = await this.store.openModal<"yes" | "no">("select", {
      title: message,
      options: [
        { value: "yes", label: "是" },
        { value: "no", label: "否" },
      ],
    });
    return v === "yes";
  }
  async select<T extends string = string>(
    title: string,
    options: readonly SelectOption<T>[],
  ): Promise<T | typeof CANCEL> {
    const v = await this.store.openModal<T>("select", { title, options });
    return v === undefined ? CANCEL : v;
  }

  // 用户消息块(chat.ts 在 append 到历史后调用,让 TUI 回卷里也显示用户一问)
  showUser(text: string): void {
    this.store.pushUser(text);
  }

  // 会话收尾:先 deactivate(之后的提示改直写 stdout,不会塞给已卸载的 Ink),再卸载 Ink。
  // 幂等 —— chat.ts 的 cancel 分支与函数末尾都会调到
  shutdown(): void {
    if (!this.store.isActive()) return;
    this.store.setActivity("idle");
    this.store.deactivate();
    this.exitHook?.();
    this.exitHook = null;
  }
}