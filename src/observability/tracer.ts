import { dirname } from "node:path";
import pc from "picocolors";
import { tracePath } from "../config/paths.ts";

// 一条 trace 事件的结构。所有方法最终都产出一个 TraceEvent 落盘。
export interface TraceEvent {
  sid: string; // 会话 id。所有会话追加进同一个 jsonl,靠它切出单次会话做前后对比
  seq: number; // 全局递增序号，看流程顺序用
  round: number; // 第几轮 agent loop；session 级事件用 0
  type:
    | "session_start" // 会话开始
    | "session_end" // 会话结束(带汇总)
    | "llm_start" // 一次 sendMessages 调用开始(点事件)
    | "llm_end" // 一次 sendMessages 结束(段事件,带 duration)
    | "tool_call" // 工具调用开始(点事件)
    | "tool_result" // 工具返回(段事件,带 duration)
    | "user_message" // 用户在本会话中发送的一条消息
    | "llm_raw" // 某轮 LLM 返回的原始 SSE data(JSON.parse 前),诊断 think/content 用
    | "nudge" // 空回答兜底:模型本轮无 content/tool_calls,harness 注入续轮提示
    | "compaction" // 上下文压缩:prompt_tokens 达阈值,旧历史被摘要替代(点事件,带切点/摘要长度)
    | "approval" // 权限门:一次人工确认(允许/会话放行/拒绝),A/B 时看模型尝试危险操作的频率
    | "tool_gate" // 工具护栏:read-before-write/冲突检测拦截(harness 兜底,不带模型主观判断)
    | "doom_loop" // 死循环检测:连续 N 次相同工具调用,带工具名/参数/用户决定
    | "retry" // LLM 请求重试:云端 API 抖动(429/5xx/网络错误),带次数/退避时长/原因
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
  finishReason?: string | null; // 模型本轮的 finish_reason(stop/tool_calls/length/null),判停兜底用
  usage?: {
    // 来自最后一个 usage chunk 的 token 用量,可能拿不到
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 会话开始时记录的实验元数据:提示词 A/B 对比全靠 session_start 里的这几个字段
export interface SessionMeta {
  promptVersion: string; // "none" = 无系统提示词基线;"v1"/"v2" = 实验组
  systemPromptChars: number; // 系统提示词字符数(none 时为 0)
  model: string; // 用的哪个模型,不同模型的 trace 不可比
  cid?: string; // 关联的对话 id(见 src/history/store.ts)。续话时新 sid 复用旧 cid,靠它把多次 run 关联到同一段对话
}

// 会话结束时的汇总
export interface SessionSummary {
  promptVersion: string; // 冗余一份,单看 session_end 也知道是哪组实验
  totalRounds: number; // 总轮数
  totalDuration: number; // 总耗时(ms)
  totalTokens: number; // 累计 completion tokens
  totalPromptTokens: number; // 累计 prompt tokens(每轮重发全量上下文,这是真实成本口径)
  toolCalls: number; // 工具调用总次数
  toolFailures: number; // 工具失败次数(ok:false),提示词是否改善工具纪律看这个
}

// 工具结果/参数预览的最大长度,防止 13k 的 html content 撑爆 trace 文件
const PREVIEW_LEN = 200;
// 单条 SSE 原始报文的截断长度:逐 chunk 截断而非整体截断,
// 保证每个 chunk 的字段结构(reasoning vs content)都完整可见——这正是诊断 think/content 需要的
const RAW_CHUNK_LEN = 1500;

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
  // 累计的 completion tokens,endSession 汇总用
  private totalCompletionTokens = 0;
  // 累计的 prompt tokens(每轮都重发全量上下文,累加才是真实成本)
  private totalPromptTokens = 0;
  // 工具调用/失败计数,endSession 汇总用
  private toolCallCount = 0;
  private toolFailureCount = 0;
  // 会话 id + 实验元数据,startSession 时锚定
  private sessionId = "";
  private meta: SessionMeta = { promptVersion: "?", systemPromptChars: 0, model: "?" };
  // 落盘路径(见 config/paths.ts:全局 ~/.coderig/,不污染用户项目目录)。
  // 函数惰性求值:Tracer 实例化可能早于 env 就绪(见 paths.ts 的设计说明)
  private logPath = tracePath();

  // 会话开始:记一条 session_start(带实验元数据),生成 sessionId 并锚定 sessionStart
  startSession(meta?: SessionMeta) {
    this.sessionStart = Date.now();
    this.sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    if (meta) this.meta = meta;
    this.push("session_start", { ...this.meta });
  }

  // 会话结束:Tracer 内部已有全部汇总所需数据(round/sessionStart/各计数器),
  // 自行计算并落 session_end + 打终端总结——调用方无需传任何参数
  endSession() {
    const summary: SessionSummary = {
      promptVersion: this.meta.promptVersion,
      totalRounds: this.round,
      totalDuration: Date.now() - this.sessionStart,
      totalTokens: this.totalCompletionTokens,
      totalPromptTokens: this.totalPromptTokens,
      toolCalls: this.toolCallCount,
      toolFailures: this.toolFailureCount,
    };
    this.push("session_end", summary);
    // 终端打一行汇总:实验组 / 轮数 / 总耗时 / 双向 token / 工具成败
    const sec = (summary.totalDuration / 1000).toFixed(1);
    process.stdout.write(
      `\n✓ 完成 [${summary.promptVersion}] · ${summary.totalRounds} 轮 · ${sec}s` +
        ` · ↑${summary.totalPromptTokens} ↓${summary.totalTokens} tokens` +
        ` · 工具 ${summary.toolCalls} 次(失败 ${summary.toolFailures})\n`,
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
    if (meta.usage) {
      this.totalCompletionTokens += meta.usage.completion_tokens;
      this.totalPromptTokens += meta.usage.prompt_tokens;
    }
    this.push("llm_end", {
      ...meta, // contentLen/reasoningLen/toolCallsCount/usage
      duration: Date.now() - this.roundStartTs,
    });
  }

  // 工具调用开始:记 tool_call(点事件),args 截断后存。
  // 并行工具后 toolCall/toolResult 不再严格交替,单一 toolStartTs 会被后发的 toolCall 覆盖,
  // 改用 callId → {开始时间, args预览} 的映射配对,duration 和 🔧 行的 args 才不会串
  private toolStarts = new Map<string, { startTs: number; argsPreview: string }>();

  toolCall(name: string, args: unknown, callId: string) {
    this.toolCallCount++;
    const argsPreview = this.truncate(args);
    this.toolStarts.set(callId, { startTs: Date.now(), argsPreview });
    this.push("tool_call", { name, args: argsPreview });
  }

  // 权限确认通过后重新锚定开始时间。用户看确认框的耗时不是工具执行耗时——
  // 不重置的话 tool_result 的 duration 会把人的犹豫算进工具耗时
  // (实测:write_file 实际执行 4ms,trace 里记了 11.8s,全是等用户点确认的时间)
  toolApproved(callId: string) {
    const s = this.toolStarts.get(callId);
    if (s) this.toolStarts.set(callId, { ...s, startTs: Date.now() });
  }

  // 工具返回:记 tool_result(段事件),duration = 现在 - 该 callId 对应的开始时间,result 截断
  // 实时展示:name(args预览) → result预览 · 耗时,让用户既看到传了啥参数、又看到返回啥
  toolResult(name: string, result: string, ok: boolean, callId: string) {
    if (!ok) this.toolFailureCount++;
    const start = this.toolStarts.get(callId);
    this.toolStarts.delete(callId); // 配对完即清,防 Map 随会话无限增长
    const resultPreview = this.truncate(result);
    const event = this.push("tool_result", {
      name,
      result: resultPreview,
      ok,
      duration: start ? Date.now() - start.startTs : 0, // 找不到配对(不应发生)时记 0,不致崩
    });
    const dur = event.duration ?? 0;
    process.stdout.write(
      `\n🔧 ${name}(${start?.argsPreview ?? ""}) → ${resultPreview} · ${dur}ms\n`,
    );
  }

  // 用户消息:记一条 user_message(点事件),text 截断后存。用于回放"用户每轮问了啥"
  userMessage(text: string) {
    this.push("user_message", { text: this.truncate(text) });
  }

  // 某轮 LLM 的原始 SSE 报文:逐 chunk 截断后整体存,每行 = 一条原始 data
  llmRaw(raw: string) {
    const capped = raw
      .split("\n")
      .map((line) => this.truncate(line, RAW_CHUNK_LEN))
      .join("\n");
    this.push("llm_raw", { raw: capped });
  }

  // 空回答兜底:模型本轮无 content 也无 tool_calls,harness 注入 nudge 续轮。
  // reason 记原因(finish_reason 等),终端打一行灰色提示让用户知道发生了啥(不是静默结束)
  nudge(reason: string) {
    this.push("nudge", { reason });
    process.stdout.write(pc.dim(`\n↻ 续轮提示:模型本轮无回答/无工具调用(${reason}),已注入提示继续\n`));
  }
  
  // 上下文压缩:记切点/摘要长度/触发时的 prompt_tokens,终端打灰色提示。
  // 这是观察压缩策略好坏的核心事件:压得太勤/摘要太长都靠它看趋势
  compaction(info: { cutIndex: number; summaryLen: number; promptTokens: number }) {
    this.push("compaction", info);
    process.stdout.write(
      pc.dim(
        `\n⊘ 上下文压缩:prompt_tokens=${info.promptTokens} 达阈值,前 ${info.cutIndex} 条已折叠为 ${info.summaryLen} 字摘要\n`,
      ),
    );
  }

  // 权限门:只在"问了用户"或"硬禁止"时记——auto 放行是主流路径,记了全是噪音。
  // A/B 时按 sid 统计 approval 事件密度,看提示词是否影响模型尝试危险操作的频率
  approval(info: {
    tool: string;
    action: "ask" | "deny"; // ask=问了用户,deny=安全策略硬禁
    // 用户/策略的最终决定:allow=允许一次, session_allow=会话放行,
    // persist_allow=写入 settings.json 持久放行, deny=拒绝
    decision: "allow" | "session_allow" | "persist_allow" | "deny";
    reason: string;
  }) {
    this.push("approval", info);
  }

  // LLM 请求重试:云端 API 的抖动(429/5xx/网络错误)是切换云端后新出现的失败面。
  // 逐次记下来,事后能看到"哪家供应商什么时段不稳",而不是只看到最终的失败
  retry(info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
  }) {
    this.push("retry", info);
  }

  // 死循环检测:模型连续 N 次发出完全相同的工具调用(同名同参)。
  // 记工具名、参数(截断)和用户的决定——A/B 时能看出哪版提示词更容易让模型卡死
  doomLoop(info: { tool: string; args: string; decision: "continue" | "stop" }) {
    this.push("doom_loop", info);
  }

  // 工具护栏拦截:read-before-write 或冲突检测拦下了这次写操作。
  // 这是 harness 兜底层面的观测——记录"模型多少次尝试在未读/读后过时的情况下写文件",
  // 不中断对话(工具结果里已带错误回填给模型自纠)
  toolGate(info: { kind: "read_before_write" | "conflict"; tool: string; path: string }) {
    this.push("tool_gate", info);
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
      sid: this.sessionId,
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

  // 写盘队列:appendFile 是异步的,事件密集时并发写会乱序(seq 1,4,6,2…),
  // 用 promise 链把每次写串在上一次后面,保证文件里的行序 = 事件序
  private writeQueue: Promise<void> = Promise.resolve();

  // 把单条事件追加写入 jsonl 文件(每行一个 JSON,流式友好、可 tail -f / jq)。
  // 保留 node:fs/promises appendFile:Bun.file().writer() 每次都要打开关闭,
  // 不适合高频小追加(每事件一次),appendFile 是更直接的追加语义
  private persist(event: TraceEvent) {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const { appendFile, mkdir } = await import("node:fs/promises");
        await mkdir(dirname(this.logPath), { recursive: true });
        await appendFile(this.logPath, JSON.stringify(event) + "\n", "utf8");
      } catch {
        // 落盘失败不能影响主流程(观测层不能把 agent 搞崩),静默吞掉
      }
    });
  }

  // 实时终端展示:从事件派生简短输出,让用户跑的过程中有感知
  // 注意:不要再打 round 标记——它紧跟 loading.start() 的 spinner,会被一帧覆盖,
  // 用户只看到一闪而逝的 round 信息。round/usage 等都已在 trace 文件里,终端不重复打。
  private display(event: TraceEvent) {
    switch (event.type) {
      case "tool_result":
        // tool_result 在 toolResult() 里已专门打(🔧 name → result · 耗时),这里不重复
        break;
      default:
        break;
    }
  }

  // 截断大字符串/对象为预览长度,避免 13k 的 html content 撑爆 trace 文件
  private truncate(value: unknown, max = PREVIEW_LEN): string {
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
    return s.length > max ? s.slice(0, max) + "…" : s;
  }
}
