import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// 一条 trace 事件的结构。所有方法最终都产出一个 TraceEvent 落盘。
export interface TraceEvent {
  seq: number; // 全局递增序号，看流程顺序用
  round: number; // 第几轮 agent loop；session 级事件用 0
  type:
    | "session_start" // 会话开始
    | "session_end" // 会话结束(带汇总)
    | "llm_start" // 一次 sendMessages 调用开始(点事件)
    | "llm_end" // 一次 sendMessages 结束(段事件,带 duration)
    | "tool_call" // 工具调用开始(点事件)
    | "tool_result" // 工具返回(段事件,带 duration)
    | "error"; // 错误
  ts: number; // 相对 session 开始的毫秒
  duration?: number; // 仅段事件有:本段耗时(ms)
  data?: any; // 类型相关载荷(llm_end带usage、tool_call带args、tool_result带result等)
}

// llm_end 事件携带的载荷:本轮 LLM 调用的元信息
export interface LlmEndMeta {
  contentLen: number; // 本轮 content 总字符数(累计流式片段)
  reasoningLen: number; // 本轮 reasoning 总字符数
  toolCallsCount: number; // 本轮产出几个 tool_call
  usage?: {
    // 来自最后一个 usage chunk 的 token 用量,可能拿不到
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 会话结束时的汇总
export interface SessionSummary {
  totalRounds: number; // 总轮数
  totalDuration: number; // 总耗时(ms)
  totalTokens: number; // 累计 completion tokens
}

// 工具结果/参数预览的最大长度,防止 13k 的 html content 撑爆 trace 文件
const PREVIEW_LEN = 200;

export class Tracer {
  // 已推入的事件(内存里留一份,endSession 时其实已流式落盘,这里也留作汇总用)
  private events: TraceEvent[] = [];
  // 全局递增序号,每次 push 自增
  private seq = 0;
  // 当前在第几轮 agent loop
  private round = 0;
  // session 开始的绝对时间戳,所有 ts 都相对它算
  private sessionStart = 0;
  // 本轮 LLM 调用开始的绝对时间戳,llmEnd 算 duration 用
  private roundStartTs = 0;
  // 当前工具调用开始的绝对时间戳,toolResult 算 duration 用
  private toolStartTs = 0;
  // 累计的 completion tokens,endSession 汇总用
  private totalCompletionTokens = 0;
  // 落盘路径
  private logPath = "logs/trace.jsonl";

  // 会话开始:记一条 session_start,并把 sessionStart 锚定(后续 ts 都相对它)
  startSession() {
    this.sessionStart = Date.now();
    this.push("session_start", { ts_note: "会话开始" });
  }

  // 会话结束:Tracer 内部已有全部汇总所需数据(round/sessionStart/totalCompletionTokens),
  // 自行计算并落 session_end + 打终端总结——调用方无需传任何参数
  endSession() {
    const summary: SessionSummary = {
      totalRounds: this.round,
      totalDuration: Date.now() - this.sessionStart,
      totalTokens: this.totalCompletionTokens,
    };
    this.push("session_end", summary);
    // 终端打一行汇总:轮数 / 总耗时 / 总 token
    const sec = (summary.totalDuration / 1000).toFixed(1);
    process.stdout.write(
      `\n✓ 完成 · ${summary.totalRounds} 轮 · ${sec}s · ${summary.totalTokens} tokens\n`,
    );
  }

  // 进入下一轮 agent loop(round 自增)。llmStart 前调一次。
  nextRound() {
    this.round++;
  }

  // LLM 调用开始:记 llm_start(点事件),并把 roundStartTs 锚定供 llmEnd 算 duration
  llmStart() {
    this.roundStartTs = Date.now();
    this.push("llm_start", { round: this.round });
  }

  // LLM 调用结束:记 llm_end(段事件),duration = 现在 - 本轮开始
  // meta 里的 usage 若存在,累计 completion tokens 供会话汇总
  llmEnd(meta: LlmEndMeta) {
    if (meta.usage) this.totalCompletionTokens += meta.usage.completion_tokens;
    this.push("llm_end", {
      ...meta, // contentLen/reasoningLen/toolCallsCount/usage
      duration: Date.now() - this.roundStartTs,
    });
  }

  // 工具调用开始:记 tool_call(点事件),args 截断后存,锚定 toolStartTs
  // 同时记下本次调用的 args 预览,供 toolResult 展示时复用(避免 toolResult 拿不到 args)
  private lastToolName = "";
  private lastToolArgsPreview = "";

  toolCall(name: string, args: unknown) {
    this.toolStartTs = Date.now();
    this.lastToolName = name;
    this.lastToolArgsPreview = this.truncate(args);
    this.push("tool_call", { name, args: this.lastToolArgsPreview });
  }

  // 工具返回:记 tool_result(段事件),duration = 现在 - 该工具调用开始,result 截断
  // 实时展示:name(args预览) → result预览 · 耗时,让用户既看到传了啥参数、又看到返回啥
  toolResult(name: string, result: string, ok: boolean) {
    const resultPreview = this.truncate(result);
    const event = this.push("tool_result", {
      name,
      result: resultPreview,
      ok,
      duration: Date.now() - this.toolStartTs, // 段事件耗时:现在 - toolCall 时锚定的 toolStartTs
    });
    const dur = event.duration ?? 0;
    process.stdout.write(
      `\n🔧 ${name}(${this.lastToolArgsPreview}) → ${resultPreview} · ${dur}ms\n`,
    );
  }

  // 错误:记 error 事件
  error(message: string) {
    this.push("error", { message });
  }

  // 内部:把一条事件推入 events 数组 + 立即追加落盘 + 实时展示
  // 关键设计:流式落盘——每条立刻 appendFile,程序崩了也已落盘的部分还在
  private push(type: TraceEvent["type"], data: any): TraceEvent {
    // 算 duration:仅段事件(llm_end/tool_result)在 data 里带了 duration,这里取出挂到事件顶层
    const duration = typeof data?.duration === "number" ? data.duration : undefined;
    const event: TraceEvent = {
      seq: ++this.seq,
      round: type === "session_start" || type === "session_end" ? 0 : this.round,
      type,
      ts: Date.now() - this.sessionStart, // 相对 session 开始的 ms
      ...(duration !== undefined ? { duration } : {}), // 仅段事件带 duration
      ...(data !== undefined ? { data } : {}),
    };
    this.events.push(event);
    this.persist(event); // 立即落盘
    this.display(event); // 实时终端展示
    return event;
  }

  // 把单条事件追加写入 jsonl 文件(每行一个 JSON,流式友好、可 tail -f / jq)
  private async persist(event: TraceEvent) {
    try {
      await mkdir(dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // 落盘失败不能影响主流程(观测层不能把 agent 搞崩),静默吞掉
    }
  }

  // 实时终端展示:从事件派生简短输出,让用户跑的过程中有感知
  // 不是把每条都打(太吵),只打关键节点:llm_start(round 标记)、tool_result(已在 toolResult 打)、session_end(已在 endSession 打)
  private display(event: TraceEvent) {
    switch (event.type) {
      case "llm_start":
        // 每轮开头打个 round 标记,让用户知道"这是第几轮、模型又开始想了"
        process.stdout.write(`\n● round ${event.round} · 思考中…`);
        break;
      case "tool_call":
      case "tool_result":
      case "llm_end":
      case "error":
        // tool_result 在 toolResult() 已专门打;llm_end/error 不单独打,避免和流式输出打架
        break;
    }
  }

  // 截断大字符串/对象为预览长度,避免 13k 的 html content 撑爆 trace 文件
  private truncate(value: unknown): string {
    let s: string;
    if (typeof value === "string") {
      s = value;
    } else {
      try {
        s = JSON.stringify(value);
      } catch {
        s = String(value);
      }
    }
    return s.length > PREVIEW_LEN ? s.slice(0, PREVIEW_LEN) + "…" : s;
  }
}
