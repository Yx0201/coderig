import type { SSEChunk } from "./types.ts";

// onRaw: 可选回调,在 JSON.parse 之前把每条 SSE 的原始 data 字符串透传出去,
// 供观测层落盘——诊断"模型到底发了 reasoning 还是 content"时,要看的就是这条原始报文,
// 而不是我们 parse 后的 StreamEvent。不传则无任何开销。
export async function* parseSSE(
  response: Response,
  onRaw?: (raw: string) => void,
): AsyncGenerator<SSEChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        onRaw?.(data); // ← 在 parse 前透传原始报文,诊断 think/content 的依据
        try {
          const parsed = JSON.parse(data);
          yield parsed;
        } catch {
          continue;
        }
      }
    }
  }
}
