import type { ChatMessage } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";

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

// 把一条消息序列化成摘要输入的一行。工具结果截断——摘要不需要工具输出全文
function lineOf(m: ChatMessage): string {
  const body =
    m.role === "tool"
      ? `[${m.name ?? "?"} 结果] ${(m.content ?? "").slice(0, 300)}`
      : (m.content ?? "");
  const calls = m.tool_calls
    ?.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 120)})`)
    .join(", ");
  return `${m.role}: ${body}${calls ? ` [调用工具: ${calls}]` : ""}`;
}

// 生成新摘要:旧摘要 + 本次被压掉的消息 → 一条新 summary。
// 不传 tools(摘要任务不该调工具);流式收集 content,忽略 reasoning。
// 失败往上抛,由调用方决定降级策略(压缩失败不能搞崩对话主流程)
export async function summarize(
  prevSummary: string | null,
  cutMsgs: readonly ChatMessage[],
): Promise<string> {
  const transcript = cutMsgs.map(lineOf).join("\n");
  const input: ChatMessage[] = [
    {
      role: "user",
      content:
        (prevSummary ? `[更早历史的既有摘要]\n${prevSummary}\n\n` : "") +
        `[对话历史]\n${transcript}\n\n${SUMMARIZE_INSTRUCTION}`,
    },
  ];
  let out = "";
  for await (const event of sendMessages(input)) {
    if (event.type === "content") out += event.text;
  }
  if (!out.trim()) throw new Error("摘要为空");
  return out.trim();
}
