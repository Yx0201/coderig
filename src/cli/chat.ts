import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";
import { get, listDefs } from "../tools/registry.ts";
import { Tracer } from "../observability/tracer.ts";
import { resolveSystemPrompt } from "../prompts/system.ts";
import { History } from "../history/store.ts";
import { shouldCompact } from "../history/context.ts";

const tracer = new Tracer();

// 续话:传一个已有 cid,把那段对话的转录灌回内存接着聊;
// 不传则新开一段对话。两种情况都各自记一份观测(trace 的新 sid),但 cid 跨续话保持不变
export async function startChat(resumeCid?: string) {
  tracer.clearLog(); // 每次运行开头清空旧日志,本次 trace 干净(见 CLAUDE.md 观测约定)
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
        for await (const event of sendMessages(
          history.contextMessages, // 发送视图:压缩/裁剪后的投影,而非完整转录(见 history/context.ts)
          listDefs(),
        )) {
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

      // 上下文压缩检查:用本轮 API 返回的真实 prompt_tokens 对阈值(不做本地估算)。
      // 放在判停之前:无论下一步是续轮调工具还是等用户新输入,下次请求都用压缩后的视图,
      // 避免超阈值的大上下文再被原样发一次。压缩失败只记错降级继续,不能搞崩对话
      if (currentUsage && shouldCompact(currentUsage.prompt_tokens)) {
        try {
          const r = await history.compact();
          if (r)
            tracer.compaction({ ...r, promptTokens: currentUsage.prompt_tokens });
        } catch (err) {
          tracer.error(
            `上下文压缩失败,降级继续: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 判停 + 执行 + 回填
      if (!toolCallsToRun || toolCallsToRun.length === 0) {
        // finish_reason=length:被截断,nudge 无益(还会被截),记下并终止
        if (currentFinishReason === "length") {
          tracer.error("本轮被截断(finish_reason=length),可能上下文过长");
          renderError("模型输出被截断,本轮无完整回答");
          if (answer.trim())
            history.append({ role: "assistant", content: answer });
          break;
        }
        const hasContent = answer.trim().length > 0;
        // 有 content → 正常最终回答,收工
        if (hasContent) {
          history.append({ role: "assistant", content: answer });
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
        history.append({ role: "assistant", content: answer });
        history.append({ role: "user", content: NUDGE_TEXT });
        tracer.nudge(
          `第 ${emptyRounds} 次 · finish_reason=${currentFinishReason ?? "null"} · reasoningLen=${reasoningLen}`,
        );
        continue; // 不 break,回到内层 while 顶再问一次模型
      }

      // 走到这里说明有工具调用:模型本轮有产出,空回答计数归零
      emptyRounds = 0;

      // 有工具调用：先回填 assistant（带 tool_calls）
      history.append({
        role: "assistant",
        content: answer,
        tool_calls: toolCallsToRun,
      });

      // 并行执行所有工具:执行并发省时,但回填按 tool_calls 原始顺序——
      // 转录确定性比完成顺序重要(同样的对话重放应产生同样的 transcript)。
      // 失败(含 handler 意外 throw)一律归一化成"错误："前缀回填,
      // 由模型看到具体原因后自主决定重试/换参数(errors as observations)
      const settled = await Promise.allSettled(
        toolCallsToRun.map(async (tc) => {
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

          tracer.toolCall(tc.function.name, args, tc.id); // 记工具调用开始(点事件),带 callId 供并行下配对

          const entry = get(tc.function.name);
          if (!entry) {
            return { result: `错误：未知工具 ${tc.function.name}`, ok: false };
          }
          const result = await entry.handler(args);
          // 全部工具约定失败时返回"错误："前缀,靠它判定 ok,否则 toolFailures 永远是 0
          return { result, ok: !result.startsWith("错误") };
        }),
      );

      settled.forEach((s, i) => {
        const tc = toolCallsToRun![i]!;
        // rejected = handler 意外 throw(工具约定之外的异常),也走"错误："口径,
        // 保证协议要求的"每个 tool_call_id 必有回应",且统计不漏
        const { result, ok } =
          s.status === "fulfilled"
            ? s.value
            : {
                result: `错误：工具执行异常 ${tc.function.name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
                ok: false,
              };

        tracer.toolResult(tc.function.name, result, ok, tc.id); // 记工具返回(段事件,带 duration,实时打 🔧 行)

        history.append({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result,
        });
      });
    }

    process.stdout.write("\n"); // 一次对话(可能多轮)结束，换行分隔下一轮 prompt
  }
}
