import type { ChatMessage,StreamEvent } from "./types.ts";
import { parseSSE } from "./stream.ts";

const url = process.env.BASE_URL || "";
const endpoint = process.env.ENDPOINT || "";
const ak = process.env.API_KEY || "";
const model = process.env.MODEL || "";

export async function* sendMessages(
  messages: ChatMessage[],
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
      stream: true,
    }),
  });

  if (!response.ok)
    throw new Error(
      `Request failed with status ${response.status} ${response.statusText}`,
    );

  //   yield* parseSSE(response);

  for await (const chunk of parseSSE(response)) {
    const delta = chunk.choices?.[0]?.delta;
    if(delta?.content) yield { type: "content", text: delta.content };
    if(delta?.reasoning) yield { type: "reasoning", text: delta.reasoning };
   
  }
}
