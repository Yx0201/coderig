import type { ChatMessage } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import { CONTEXT_WINDOW_TOKENS } from "./context.ts";

// ===== 摘要压缩(调 LLM 的部分,与 context.ts 的纯逻辑分开) =====
//
// 把"被压掉的消息"喂给模型生成结构化摘要。旧摘要一并折叠进去,
// 所以任意时刻压缩状态只有一条 summary,不会摘要套摘要地链式增长。

// 摘要指令:要求保留后续行动必需的信息,而不是泛泛的"聊了什么"
const SUMMARIZE_INSTRUCTION =
  "请把上面这段对话历史压缩成一份摘要,供后续对话作为背景使用。要求:\n" +
  "1. 保留用户的核心目标和尚未完成的任务;\n" +
  "2. 保留关键结论、决定和约束条件;\n" +
  "3. 保留涉及的文件路径、命令、代码标识符等精确信息;\n" +
  "4. 省略寒暄、过程性讨论和已被推翻的方案;\n" +
  "5. 直接输出摘要正文,不要任何前言。";

// 摘要输入里每类内容各自的截断上限。分开设而非一刀切:
// 工具结果是可重新获取的派生数据(截狠一点没关系),而 user/assistant 正文是
// 任务意图本身——用户粘的那段长报错可能正是"要解决什么"的全部信息,
// 一律截到 300 会把目标本身截掉,摘要出来就是空话。
// 这也是 opencode serialize() 的做法:每种 role 走各自的序列化分支,
// 只对 tool 输出用 TOOL_OUTPUT_MAX_CHARS 硬截
const TOOL_LINE_MAX = 300; // 工具结果:留个头就够,细节可重新调工具取
const TEXT_LINE_MAX = 2000; // user/assistant 正文:任务意图,留足
const ARGS_LINE_MAX = 200; // 工具参数:路径/pattern 够看,不带文件全文

// 单条文本截断:保头保尾(长报错的关键信息常在末尾),掐中间
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max * 0.3);
  return `${text.slice(0, max - tail)}…[省略 ${text.length - max} 字符]…${text.slice(-tail)}`;
}

// 把一条消息序列化成摘要输入的一行。按 role 分流,各自用合适的上限,
// 且空 content 的 assistant(只调工具那种)不会退化成一行空的 "assistant: "
function lineOf(m: ChatMessage): string {
  const calls = m.tool_calls
    ?.map((t) => `${t.function.name}(${clip(t.function.arguments, ARGS_LINE_MAX)})`)
    .join(", ");

  if (m.role === "tool")
    return `[工具结果 ${m.name ?? "?"}] ${clip(m.content ?? "", TOOL_LINE_MAX)}`;

  const body = clip(m.content ?? "", TEXT_LINE_MAX);
  const who = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : m.role;
  // assistant 常常 content 为空、只有 tool_calls,这时不输出空正文
  if (!body && calls) return `${who}: [调用工具: ${calls}]`;
  return `${who}: ${body}${calls ? ` [调用工具: ${calls}]` : ""}`;
}

// 生成新摘要:旧摘要 + 本次被压掉的消息 → 一条新 summary。
// 不传 tools(摘要任务不该调工具),也不注入编码助手 sysprompt
// (那套"改代码先 read_file / 必须跑 tsc"的纪律与摘要任务无关,只会带偏);
// 流式收集 content,忽略 reasoning。
// 失败往上抛,由调用方决定降级策略(压缩失败不能搞崩对话主流程)
export async function summarize(
  prevSummary: string | null,
  cutMsgs: readonly ChatMessage[],
): Promise<string> {
  // 摘要请求自己也必须装得进窗口。压缩往往正是"上下文已经太大"时触发的,
  // 若把整个被压区原样喂进去,摘要这一发请求会比原请求还大,直接 400 撑爆——
  // 压缩反而成了压垮对话的那根稻草。opencode 同样在发摘要前校验
  // Token.estimate(summaryPrompt) > context - summaryOutput 就放弃。
  // 这里用字符预算(约 3.5 字符/token)近似:留一半窗口给摘要输入,
  // 剩下给指令、旧摘要和输出。超了就从最旧的行开始丢(旧的已被上一轮摘要覆盖过)
  const budgetChars = Math.floor(CONTEXT_WINDOW_TOKENS * 0.5 * 3.5);
  const lines = cutMsgs.map(lineOf);
  let transcript = lines.join("\n");
  if (transcript.length > budgetChars) {
    const kept: string[] = [];
    let acc = 0;
    // 从最新往回收,保住离当前任务最近的历史
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (acc + l.length > budgetChars) break;
      kept.unshift(l);
      acc += l.length;
    }
    const dropped = lines.length - kept.length;
    transcript =
      (dropped > 0 ? `[更早的 ${dropped} 条已省略,其要点见既有摘要]\n` : "") +
      kept.join("\n");
  }
  const input: ChatMessage[] = [
    {
      role: "user",
      content:
        (prevSummary ? `[更早历史的既有摘要]\n${prevSummary}\n\n` : "") +
        `[对话历史]\n${transcript}\n\n${SUMMARIZE_INSTRUCTION}`,
    },
  ];
  let out = "";
  for await (const event of sendMessages(input, undefined, {
    noSystemPrompt: true,
  })) {
    if (event.type === "content") out += event.text;
  }
  if (!out.trim()) throw new Error("摘要为空");
  return out.trim();
}
