import type { ChatMessage, StreamEvent, ToolDef,ToolCall } from "./types.ts";
import { parseSSE } from "./stream.ts";

const url = process.env.BASE_URL || "";
const endpoint = process.env.ENDPOINT || "";
const ak = process.env.API_KEY || "";
const model = process.env.MODEL || "";

export async function* sendMessages(
  messages: ChatMessage[],
  tools?: ToolDef[],
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ak}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true }, // 让流式最后一个 chunk 携带 token 用量
    }),
  });

  if (!response.ok)
    throw new Error(
      `Request failed with status ${response.status} ${response.statusText}`,
    );

  const acc = new Map<
    number,
    {
      id?: string;
      name?: string;
      arguments: string;
    }
  >();

  for await (const chunk of parseSSE(response)) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) yield { type: "content", text: delta.content };
    if (delta?.reasoning) yield { type: "reasoning", text: delta.reasoning };
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        // 取出该 index 的槽，没有就建一个空槽
        const slot = acc.get(tc.index) ?? { arguments: "" };
        if (tc.id) slot.id = tc.id; // 首个chunk才有id，有就覆盖没就保留
        if (tc.function?.name) slot.name = tc.function.name; // 同上
        if (tc.function?.arguments) slot.arguments += tc.function.arguments; // arguments累加
        acc.set(tc.index, slot);
      }
    }
    // 带 include_usage 的最后一个 chunk：choices 为空、只带 usage
    if (chunk.usage) yield { type: "usage", usage: chunk.usage };
  }

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
