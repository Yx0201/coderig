import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";

export async function startChat() {
  process.stdout.write("welcome to the chat!\n");

  const loading = renderLoading();
  let history: ChatMessage[] = [];

  while (true) {
    const input = await p.text({
      message: "请输入信息",
    });

    if (p.isCancel(input)) {
      console.log("Bey~");
      break;
    }

    if (!input.trim()) continue;
    history = [...history, { role: "user", content: input }];
    loading.start();
    let started = false;
    let answer = "";
    let lastType: "reasoning" | "content" | null = null;
    try {
      for await (const event of sendMessages(history)) {
        if (!started) {
          loading.stop();
          // 清除 loading 文本
          started = true;
        }
        if (event.type === "reasoning" && lastType !== "reasoning") {
          process.stdout.write("\n[推理]: "); // 仅进入 reasoning 时打一次前缀
        }
        if (event.type === "content" && lastType === "reasoning") {
          process.stdout.write("\n"); // 思考→回答 切换，换行分隔
        }
        lastType = event.type;
        switch (event.type) {
          case "content":
            process.stdout.write(event.text);
            answer += event.text;
            break;
          case "reasoning":
            process.stdout.write(pc.dim(event.text));
            break;
        }
      }
    } catch (err) {
      if (!started) loading.stop();
      renderError(
        `请求失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (!started) loading.stop();
    }

    if (answer) history = [...history, { role: "assistant", content: answer }];
    process.stdout.write("\n");
  }
}
