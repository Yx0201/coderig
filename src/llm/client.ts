import type { ChatMessage, StreamEvent, ToolDef,ToolCall } from "./types.ts";
import { parseSSE } from "./stream.ts";
import { resolveSystemPrompt } from "../prompts/system.ts";

const url = process.env.BASE_URL || "";
const endpoint = process.env.ENDPOINT || "";
const ak = process.env.API_KEY || "";
const model = process.env.MODEL || "";
// 单次回答的输出上限(max_tokens)。DeepSeek 官方上限 384K,但不直接顶格:
// 压缩阈值是窗口的 80%(1M → 800k),顶格 384K 会让 prompt+max_tokens 越过 1M 窗口;
// 32768 保持"prompt ≤ 80% 窗口 ⇒ prompt + max_tokens ≤ 窗口"的不变量,
// 对正常回答也绰绰有余。计费按实际生成量,不按声明值
const maxTokens = Number(process.env.MAX_OUTPUT_TOKENS || 32768);

// ---- 网络韧性(切云端后新出现的失败面,本地 ollama 时代不存在) ----
// 最大重试次数(不含首发)。只重试"对方抖了"类错误:429/5xx/网络异常;
// 4xx(400 参数错、401 鉴权错)重试无意义,直接抛
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES || 3);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// 请求超时:只管"发出请求到收到响应头"这段时间(TTFB)。
// 流式 body 的传输不受它限制——长回答流几分钟是正常的,用总时长做超时会误杀长流
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60_000);

// 指数退避 + 抖动:1s/2s/4s…封顶 15s。抖动防多客户端同时重试再撞一次(thundering herd)
function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * 500, 15_000);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// opts.noSystemPrompt:不注入编码助手 sysprompt。
// 给"辅助性 LLM 调用"用(如 history 摘要):那类调用不是在扮演编码助手,
// 注入"改代码必须先 read_file / 必须跑 tsc"这类工具纪律只会污染任务
export async function* sendMessages(
  messages: readonly ChatMessage[],
  tools?: ToolDef[],
  opts?: { noSystemPrompt?: boolean },
): AsyncGenerator<StreamEvent> {
  // PROMPT_VERSION=none 时 content 为 null → 不注入,跑无系统提示词的基线
  const sys = opts?.noSystemPrompt
    ? { version: "none", content: null }
    : resolveSystemPrompt();
  const body = JSON.stringify({
    model,
    messages: sys.content
      ? [{ role: "system", content: sys.content }, ...messages]
      : messages,
    tools,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true }, // 让流式最后一个 chunk 携带 token 用量
  });

  // 重试循环:拿到 ok 的响应才出循环;可重试错误先 yield retry 事件(供观测/终端提示),
  // 退避后重发。重试耗尽或不可重试的错误,带响应体抛出——
  // DeepSeek 的 400 体里有具体原因(如 reasoning_content 未回传),不看体等于盲调
  let response: Response | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let failure: string | null = null; // 本轮失败原因(网络异常或 HTTP 状态),null=成功
    try {
      response = await fetch(`${url}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ak}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      failure = `网络异常: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer); // 响应头一到就解除超时,不限制流式 body 的传输时长
    }

    if (response?.ok) break; // 成功,出循环

    if (response) {
      // 有响应但非 2xx:读响应体(截断),判断是否值得重试
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      failure = `HTTP ${response.status}: ${detail || response.statusText}`;
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new Error(`LLM 请求失败(不可重试) ${failure}`);
      }
    }

    if (attempt > MAX_RETRIES) {
      throw new Error(`LLM 请求失败,重试 ${MAX_RETRIES} 次后放弃。最后一次: ${failure}`);
    }
    const delayMs = backoffMs(attempt);
    yield {
      type: "retry",
      attempt,
      maxAttempts: MAX_RETRIES,
      delayMs,
      reason: failure!,
    };
    await sleep(delayMs);
    response = null;
  }

  if (!response) throw new Error("LLM 请求失败:未获得响应"); // 逻辑上不可达,兜底收窄类型

  const acc = new Map<
    number,
    {
      id?: string;
      name?: string;
      arguments: string;
    }
  >();

  // 收集本轮所有 SSE 的原始 data(JSON.parse 前),流末一次性 yield 给 tracer 落盘
  const raws: string[] = [];
  // 捕获本轮 finish_reason(stop/tool_calls/length/null)。它在最后一个 content chunk 上,
  // 不在 usage chunk 上,所以要在循环里见一个记一个。判停兜底靠它区分"真回答完" vs "空收尾"
  let finishReason: string | null = null;
  // 工具参数进度的节流状态:index → 上次已上报的参数字符数。
  // 不节流的话每个 SSE chunk 都 yield 一个事件,终端刷新反而成了瓶颈
  const progressEmitted = new Map<number, number>();

  for await (const chunk of parseSSE(response, (r) => raws.push(r))) {
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (delta?.content) yield { type: "content", text: delta.content };
    if (delta?.reasoning_content)
      yield { type: "reasoning", text: delta.reasoning_content };
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        // 取出该 index 的槽，没有就建一个空槽
        const slot = acc.get(tc.index) ?? { arguments: "" };
        if (tc.id) slot.id = tc.id; // 首个chunk才有id，有就覆盖没就保留
        if (tc.function?.name) slot.name = tc.function.name; // 同上
        if (tc.function?.arguments) slot.arguments += tc.function.arguments; // arguments累加
        acc.set(tc.index, slot);
        // 进度事件:首次知道工具名、或参数又长了 512 字符时上报一次。
        // write_file 的 content 是整文件全文,流十几秒期间这是终端唯一的活动信号
        const last = progressEmitted.get(tc.index) ?? 0;
        if (tc.function?.name || slot.arguments.length - last >= 512) {
          progressEmitted.set(tc.index, slot.arguments.length);
          yield {
            type: "tool_call_progress",
            name: slot.name,
            argsChars: slot.arguments.length,
          };
        }
      }
    }
    // 带 include_usage 的最后一个 chunk：choices 为空、只带 usage
    if (chunk.usage) yield { type: "usage", usage: chunk.usage };
  }

  // 本轮原始报文:yield 一次供 tracer 落 llm_raw 事件(诊断 think/content 用)
  if (raws.length) yield { type: "raw", data: raws.join("\n") };
  // 本轮 finish_reason:判停兜底用(stop=真回答完, length=被截断, tool_calls=调工具, null=没拿到)
  yield { type: "finish", finish_reason: finishReason };

  if (acc.size > 0) {
    const tool_calls: ToolCall[] = [...acc.entries()]
      .sort(([a], [b]) => a - b) // 按 index 排序
      .map(([, slot]) => ({
        id: slot.id ?? "", // 完整态要求 id 非空
        type: "function" as const,
        function: { name: slot.name ?? "", arguments: slot.arguments },
      }));
    yield { type: "tool_calls", tool_calls };
  }
}
