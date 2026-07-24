import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";
import { get, listDefs } from "../tools/registry.ts";
import { Tracer } from "../observability/tracer.ts";
import { resolveSystemPrompt } from "../prompts/system.ts";
import { History } from "../history/store.ts";

const tracer = new Tracer();

// 续话:传一个已有 cid,把那段对话的转录灌回内存接着聊;
// 不传则新开一段对话。两种情况都各自记一份观测(trace 的新 sid),但 cid 跨续话保持不变
export async function startChat(resumeCid?: string) {
  const sys = resolveSystemPrompt();
  const model = process.env.MODEL || "?";

  // history 与 trace 分开持久化:cid 标对话,sid 标一次运行。
  // 续话 = 新 sid(新观测)+ 同一个 cid(同一段对话)。
  // 把 cid 关联进 session_start,事后看某次实验的 trace 能反查它跑的是哪段对话
  const history = resumeCid
    ? await History.load(resumeCid)
    : History.create({ model, promptVersion: sys.version });
  tracer.startSession({
    promptVersion: sys.version,
    systemPromptChars: sys.content?.length ?? 0,
    model,
    cid: history.cid,
  });
  process.stdout.write(
    resumeCid
      ? `welcome back! 续话 ${history.cid} (${history.messages.length} 条历史消息)\n`
      : `welcome to the chat! 新对话 ${history.cid}\n`,
  );

  const loading = renderLoading();

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
    history.append({ role: "user", content: input });
    tracer.userMessage(input); // 记录用户本轮的输入(点事件)

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
        for await (const event of sendMessages(history.messages, listDefs())) {
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
          // raw 是纯观测事件,不参与渲染、也不影响 lastType(否则会把"思考→回答"分隔逻辑带歪)
          if (event.type !== "usage" && event.type !== "raw") lastType = event.type;
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
            case "raw":
              tracer.llmRaw(event.data); // 本轮原始 SSE 报文落盘,诊断 think/content 用
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
        if (answer) history.append({ role: "assistant", content: answer });
        break; // ← 退出内层 while，回到外层等输入
      }

      // 有工具调用：先回填 assistant（带 tool_calls）
      history.append({
        role: "assistant",
        content: answer,
        tool_calls: toolCallsToRun,
      });

      // 执行每个工具并回填 tool 消息
      for (const tc of toolCallsToRun) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // 参数解析失败是"模型没产出规范 JSON"的信号,必须记下来——
          // 这是观察提示词是否改善工具纪律的重要指标,不能静默吞掉
          tracer.error(
            `工具参数解析失败: ${tc.function.name} ← ${tc.function.arguments.slice(0, 200)}`,
          );
        }

        tracer.toolCall(tc.function.name, args); // 记工具调用开始(点事件)

        const entry = get(tc.function.name);
        let result: string;
        let ok = true;
        if (!entry) {
          result = `错误：未知工具 ${tc.function.name}`;
          ok = false;
        } else {
          result = await entry.handler(args);
          // 全部工具约定失败时返回"错误："前缀,靠它判定 ok,否则 toolFailures 永远是 0
          if (result.startsWith("错误")) ok = false;
        }

        tracer.toolResult(tc.function.name, result, ok); // 记工具返回(段事件,带 duration,实时打 🔧 行)

        history.append({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        });
      }
    }

    process.stdout.write("\n"); // 一次对话(可能多轮)结束，换行分隔下一轮 prompt
  }
}
