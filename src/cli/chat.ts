import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";
import { get, listDefs } from "../tools/registry.ts";
import { Tracer } from "../observability/tracer.ts";
import { resolveSystemPrompt } from "../prompts/system.ts";

const tracer = new Tracer();

export async function startChat() {
  tracer.clearLog(); // 每次运行开头清空旧日志,本次 trace 干净(见 CLAUDE.md 观测约定)
  // 把本次会话的实验元数据(提示词版本/长度/模型)写进 session_start,前后对比全靠它
  const sys = resolveSystemPrompt();
  tracer.startSession({
    promptVersion: sys.version,
    systemPromptChars: sys.content?.length ?? 0,
    model: process.env.MODEL || "?",
  });
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
    tracer.userMessage(input); // 记录用户本轮的输入(点事件)

    let rounds = 0;
    // 连续空回答计数:模型本轮无 content 也无 tool_calls 时 +1,有产出时归零。
    // 防止对"只想不答"的模型无限 nudge。超过上限就明确放弃,而不是静默结束
    let emptyRounds = 0;
    const MAX_NUDGE = 2; // 最多续轮 2 次,再不答就放弃
    // nudge 文本:塞回 history 当一条 user 消息,把模型从"只想不说"拉回"给出回答或行动"
    const NUDGE_TEXT =
      "你上一轮只输出了思考,没有给出最终回答,也没有调用工具。请直接用正文回答用户,或调用工具继续完成任务。";
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
      let currentFinishReason: string | null = null; // 本轮 finish_reason,判停兜底用
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
          // raw/finish 是纯观测事件,不参与渲染、也不影响 lastType(否则会把"思考→回答"分隔逻辑带歪)
          if (
            event.type !== "usage" &&
            event.type !== "raw" &&
            event.type !== "finish"
          )
            lastType = event.type;
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
            case "finish":
              currentFinishReason = event.finish_reason; // 判停兜底靠它
              break;
            case "raw":
              tracer.llmRaw(event.data); // 本轮原始 SSE 报文落盘,诊断 think/content 用
              break;
          }
        }
        // 一轮流完,记一次 llm_end(本轮元信息 + usage + finish_reason),在循环外只调一次
        tracer.llmEnd({
          contentLen,
          reasoningLen,
          toolCallsCount: toolCallsToRun?.length ?? 0,
          finishReason: currentFinishReason,
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
        // finish_reason=length:被截断,nudge 无益(还会被截),记下并终止
        if (currentFinishReason === "length") {
          tracer.error("本轮被截断(finish_reason=length),可能上下文过长");
          renderError("模型输出被截断,本轮无完整回答");
          if (answer.trim())
            history = [...history, { role: "assistant", content: answer }];
          break;
        }
        const hasContent = answer.trim().length > 0;
        // 有 content → 正常最终回答,收工
        if (hasContent) {
          history = [...history, { role: "assistant", content: answer }];
          break;
        }
        // 无 content 且无 tool_calls → 空收尾(模型可能只吐了 reasoning 就 finish)。
        // 这正是"harness 兜底"该介入处:不再静默结束,而是 nudge 续轮让模型把话说完/行动完
        emptyRounds++;
        if (emptyRounds > MAX_NUDGE) {
          tracer.error(`连续 ${emptyRounds} 轮无回答,放弃本轮`);
          renderError("模型多次未给出回答,已停止");
          break;
        }
        // 回填本轮空 assistant(保持轮次交替),再注入 nudge user 消息,继续内层 while
        history = [...history, { role: "assistant", content: answer }];
        history = [...history, { role: "user", content: NUDGE_TEXT }];
        tracer.nudge(
          `第 ${emptyRounds} 次 · finish_reason=${currentFinishReason ?? "null"} · reasoningLen=${reasoningLen}`,
        );
        continue; // 不 break,回到内层 while 顶再问一次模型
      }

      // 走到这里说明有工具调用:模型本轮有产出,空回答计数归零
      emptyRounds = 0;

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
