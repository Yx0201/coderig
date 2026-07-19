import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";
import { get, listDefs } from "../tools/registry.ts";
import { Tracer } from "../observability/tracer.ts";

const tracer = new Tracer();

export async function startChat() {
  tracer.startSession();
  process.stdout.write("welcome to the chat!\n");

  const loading = renderLoading();
  let history: ChatMessage[] = [];

  while (true) {
    const input = await p.text({
      message: "请输入信息",
    });

    if (p.isCancel(input)) {
      tracer.endSession();
      console.log("Bey~");
      break;
    }

    if (!input.trim()) continue;
    history = [...history, { role: "user", content: input }];

    let rounds = 0;
    while (true) {
      rounds++;
      if (rounds > 10) {
        renderError("达到最大轮数，停止");
        break;
      }
      tracer.nextRound();
      tracer.llmStart();
      let answer = "";
      loading.start();
      let started = false;
      let toolCallsToRun: ToolCall[] | null = null;
      let contentLen = 0;
      let reasoningLen = 0;
      let currentUsage: any;
      let lastType: "reasoning" | "content" | "tool_calls" | null = null;
      try {
        for await (const event of sendMessages(history, listDefs())) {
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
          if (event.type !== "usage") lastType = event.type;
          switch (event.type) {
            case "content":
              process.stdout.write(event.text);
              answer += event.text;
              contentLen += event.text.length;
              break;
            case "reasoning":
              process.stdout.write(pc.dim(event.text));
              reasoningLen += event.text.length;
              break;
            case "tool_calls":
              toolCallsToRun = event.tool_calls;
              break;
            case "usage":
              currentUsage = event.usage; // usage 来自最后一个特殊 chunk,本轮结束才有
              break;
          }
        }
        // 一轮流完,记一次 llm_end(本轮元信息 + usage),在循环外只调一次
        tracer.llmEnd({
          contentLen,
          reasoningLen,
          toolCallsCount: toolCallsToRun?.length ?? 0,
          usage: currentUsage,
        });
      } catch (err) {
        const msg = `请求失败: ${err instanceof Error ? err.message : String(err)}`;
        if (!started) loading.stop();
        tracer.error(msg); // 记错误事件
        renderError(msg);
        break; // 请求失败：跳出 agent loop，不执行工具、不保存半截回答
      } finally {
        if (!started) loading.stop();
      }

      // 判停 + 执行 + 回填
      if (!toolCallsToRun || toolCallsToRun.length === 0) {
        // 没有工具调用 → 最终回答
        if (answer)
          history = [...history, { role: "assistant", content: answer }];
        break; // ← 退出内层 while，回到外层等输入
      }

      // 有工具调用：先回填 assistant（带 tool_calls）
      history = [
        ...history,
        { role: "assistant", content: answer, tool_calls: toolCallsToRun },
      ];

      // 执行每个工具并回填 tool 消息
      for (const tc of toolCallsToRun) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {}

        tracer.toolCall(tc.function.name, args); // 记工具调用开始(点事件)

        const entry = get(tc.function.name);
        let result: string;
        let ok = true;
        if (!entry) {
          result = `错误：未知工具 ${tc.function.name}`;
          ok = false;
        } else {
          result = await entry.handler(args);
        }

        tracer.toolResult(tc.function.name, result, ok); // 记工具返回(段事件,带 duration,实时打 🔧 行)

        history = [
          ...history,
          {
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: result,
          },
        ];
      }
    }

    process.stdout.write("\n"); // 一次对话(可能多轮)结束，换行分隔下一轮 prompt
  }
}
