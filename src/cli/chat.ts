import * as p from "@clack/prompts";
import { renderLoading, renderError } from "./render.ts";
import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import pc from "picocolors";
import { get, listDefs } from "../tools/registry.ts";
import { checkPermission } from "../tools/permissions.ts";
import { Tracer } from "../observability/tracer.ts";
import { resolveSystemPrompt } from "../prompts/system.ts";
import { History } from "../history/store.ts";
import {
  shouldCompact,
  hasOversizedMsg,
  contextWindowTokens,
} from "../history/context.ts";

const tracer = new Tracer();

// 续话:传一个已有 cid,把那段对话的转录灌回内存接着聊;
// 不传则新开一段对话。两种情况都各自记一份观测(trace 的新 sid),但 cid 跨续话保持不变
export async function startChat(resumeCid?: string) {
  // 不再每次清空 trace:骨架阶段已过,进入 sysprompt A/B 阶段,
  // 日志跨运行累积,靠每条事件的 sid 切出单次运行做前后对比(见 CLAUDE.md 观测约定)
  const sys = resolveSystemPrompt();
  const model = process.env.MODEL || "?";

  // history 与 trace 分开持久化:cid 标对话,sid 标一次运行。
  // 续话 = 新 sid(新观测)+ 同一个 cid(同一段对话)。
  // 把 cid 关联进 session_start,事后看某次实验的 trace 能反查它跑的是哪段对话
  const history = resumeCid
    ? await History.load(resumeCid)
    : History.create({ model, promptVersion: sys.version });
  // 转录落盘失败要留痕:静默吞掉会让"续话时少了几条消息"变成无法诊断的怪事。
  // store 不直接依赖 tracer(遵守观测约定),由这里注入上报口
  history.onWriteError = (msg) => tracer.error(msg);
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
  // 会话级权限放行名单:用户在确认提示里选"本会话不再询问 X"时加入。
  // 只记工具名粒度(bash/write_file/edit_file);危险命令与敏感路径不可放行,
  // 由 permissions.ts 的 rememberable=false 保证进不了这个集合
  const sessionAllows = new Set<string>();

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
      let reasoning = ""; // 本轮推理原文:带 tool_calls 的 assistant 消息必须原样存回 history
      loading.start();
      let started = false;
      let toolCallsToRun: ToolCall[] | null = null;
      let contentLen = 0;
      let reasoningLen = 0;
      let currentUsage: any;
      let currentFinishReason: string | null = null; // 本轮 finish_reason,判停兜底用
      let lastType: "reasoning" | "content" | "tool_calls" | null = null;
      // 工具参数进度行是否已占一行:首个进度事件先换行(不盖住在流的 reasoning),
      // 后续进度用 \r 原地刷新;content/reasoning 到来时复位
      let progressActive = false;
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
          // raw/finish/retry/tool_call_progress 是纯观测事件,不参与渲染、也不影响 lastType(否则会把"思考→回答"分隔逻辑带歪)
          if (
            event.type !== "usage" &&
            event.type !== "raw" &&
            event.type !== "finish" &&
            event.type !== "retry" &&
            event.type !== "tool_call_progress"
          )
            lastType = event.type;
          switch (event.type) {
            case "content":
              progressActive = false;
              process.stdout.write(event.text);
              answer += event.text;
              contentLen += event.text.length;
              break;
            case "reasoning":
              progressActive = false;
              process.stdout.write(pc.dim(event.text));
              reasoning += event.text;
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
            case "retry":
              // 云端 API 抖动,client 层退避后将自动重发。落盘 + 终端提示,
              // 让用户知道"卡住"是在等退避,而不是程序死了
              tracer.retry(event);
              process.stdout.write(
                pc.dim(
                  `\n⟳ 请求失败(${(event.reason ?? "").slice(0, 120)}),${(event.delayMs / 1000).toFixed(1)}s 后重试(${event.attempt}/${event.maxAttempts})\n`,
                ),
              );
              break;
            case "tool_call_progress":
              // 模型正在流式生成工具参数(write_file 写整文件时可达十几秒)。
              // 首个进度先换行(不盖住正在流的 reasoning),之后 \r 原地刷新一行
              if (!progressActive) {
                process.stdout.write("\n");
                progressActive = true;
              }
              process.stdout.write(
                `\r${" ".repeat(60)}\r` +
                  pc.dim(
                    `⏳ 正在生成 ${event.name ?? "工具调用"} 的参数… ${event.argsChars} 字符`,
                  ),
              );
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
        // 压缩要调一次 LLM 生成摘要,可能几秒——先打一行,别让用户以为卡死
        process.stdout.write(pc.dim("\n⊘ 正在压缩上下文(调用模型生成摘要)…\n"));
        try {
          const r = await history.compact();
          if (r) {
            tracer.compaction({ ...r, promptTokens: currentUsage.prompt_tokens });
          } else if (hasOversizedMsg(history.messages, history.cutIndex)) {
            // 压不动(尾部条数不够 MIN_TAIL_MSGS)但存在超上限的单条消息:
            // buildContextView 的 capContent 会就地截断,视图仍会瘦下来,不是死锁。
            // 记一条观测便于事后区分"截断兜住了"和"真的压不动"
            tracer.error(
              `压缩无可压增量,但存在超长单条消息,已由单条上限截断兜底(prompt_tokens=${currentUsage.prompt_tokens})`,
            );
          } else {
            // 既压不动、也没有超长单条消息,却仍然超阈值:
            // 说明尾部就是这么多条中等大小的消息,harness 已无手段可用。
            // 明确记下来——这是该调大 CONTEXT_WINDOW_TOKENS 或换大窗口模型的信号,
            // 而不是静默硬发到 API 报 400
            tracer.error(
              `上下文超阈值但无可压缩空间(prompt_tokens=${currentUsage.prompt_tokens},预算=${contextWindowTokens()}),建议调大 CONTEXT_WINDOW_TOKENS 或换大窗口模型`,
            );
          }
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

      // 有工具调用：先回填 assistant（带 tool_calls + reasoning_content）。
      // reasoning_content 是 DeepSeek thinking 模式的硬协议:缺了它,
      // 下一轮请求直接 400——它不是"可选的思考记录",是请求报文的一部分
      history.append({
        role: "assistant",
        content: answer,
        tool_calls: toolCallsToRun,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });

      // 执行一个工具并记观测。tracer.toolCall/toolResult 都在这里面调——
      // 紧贴真实开始/结束时刻,duration 才是该工具自己的耗时;
      // 若挪到批末统一调,每个工具量到的都是"整批耗时",快工具被慢工具污染,
      // 并行的收益在 trace 里反而看不见
      const runTool = async (tc: ToolCall) => {
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
        let result: string;
        let ok: boolean;
        if (!entry) {
          result = `错误：未知工具 ${tc.function.name}`;
          ok = false;
        } else {
          // 权限门:handler 执行前分级。auto 直接放行;deny 硬禁不问;
          // ask 弹确认(可记会话放行名单)。被拒绝/禁止也走正常 toolResult 回填——
          // 协议要求每个 tool_call_id 必有回应,且"模型尝试了什么"必须在转录里留痕
          const perm = checkPermission(tc.function.name, args, sessionAllows);
          let allowed = perm.action === "auto";
          if (perm.action === "deny") {
            tracer.approval({
              tool: tc.function.name,
              action: "deny",
              decision: "deny",
              reason: perm.reason,
            });
            process.stdout.write(pc.red(`\n⛔ 已阻止: ${perm.reason}\n`));
          } else if (perm.action === "ask") {
            // 注意:会走到这里的只有写工具(只读工具全部 auto),而写工具是串行执行的,
            // 不存在多个确认框并发的问题(见下方 parallelizable/serial 的划分)
            const choice = await p.select({
              message: `⚠ 模型请求: ${perm.reason}`,
              options: [
                { value: "allow" as const, label: "允许一次" },
                ...(perm.rememberable
                  ? [
                      {
                        value: "session" as const,
                        label: `本会话不再询问 ${tc.function.name}`,
                      },
                    ]
                  : []),
                { value: "deny" as const, label: "拒绝" },
              ],
            });
            if (p.isCancel(choice) || choice === "deny") {
              tracer.approval({
                tool: tc.function.name,
                action: "ask",
                decision: "deny",
                reason: perm.reason,
              });
            } else {
              allowed = true;
              if (choice === "session") sessionAllows.add(tc.function.name);
              tracer.approval({
                tool: tc.function.name,
                action: "ask",
                decision: choice === "session" ? "session_allow" : "allow",
                reason: perm.reason,
              });
            }
          }

          if (!allowed) {
            // 拒绝文案要点:明确告诉模型"不要换皮重试同一操作"——
            // 否则模型常把 rm 换成 mv、把被拒的命令拆成多步绕道达成,
            // 权限门就形同虚设。让用户先表态,模型再行动
            result =
              perm.action === "deny"
                ? `错误：该操作被安全策略硬禁止(${perm.reason})。请改用其它思路,或告知用户需要手动处理`
                : `错误：用户拒绝了本次操作。不要换种方式重试同一意图;请先在回复中说明你想做什么、征得用户同意后再继续`;
            ok = false;
          } else {
            // 重新锚定计时起点:权限确认等用户的耗时不能算进工具耗时
            // (实测 write_file 执行 4ms 被记成 11.8s,全是用户看确认框的时间)
            tracer.toolApproved(tc.id);
            // 慢工具提示:300ms 内跑完的不打扰(read_file 就几毫秒,提示反而是噪音);
            // 超过才打一行"执行中"(bash tsc 要几秒,静默期会让用户以为卡死)
            const slowTimer = setTimeout(() => {
              process.stdout.write(pc.dim(`⏳ ${tc.function.name} 执行中…\n`));
            }, 300);
            try {
              result = await entry.handler(args);
              // 全部工具约定失败时返回"错误："前缀,靠它判定 ok,否则 toolFailures 永远是 0
              ok = !result.startsWith("错误");
            } catch (err) {
              // handler 意外 throw(工具约定之外的异常)也归一化成"错误："回填,
              // 保证协议要求的"每个 tool_call_id 必有回应",且失败统计不漏
              result = `错误：工具执行异常 ${tc.function.name}: ${err instanceof Error ? err.message : String(err)}`;
              ok = false;
            } finally {
              clearTimeout(slowTimer);
            }
          }
        }

        tracer.toolResult(tc.function.name, result, ok, tc.id); // 记工具返回(段事件,duration=本工具真实耗时)
        return result;
      };

      // 只读工具并行、写工具串行:并发省时,但 edit_file/write_file/bash 是
      // read-modify-write,同一轮并行改同一个文件会互相覆盖(后写的赢,且两次都报成功)——
      // 这是并行化引入的数据竞争,不是模型的问题,必须在 harness 层挡住。
      // 写工具按模型给出的原始顺序依次跑,语义与串行版本完全一致
      const results = new Array<string>(toolCallsToRun.length);
      const parallelizable: number[] = [];
      const serial: number[] = [];
      toolCallsToRun.forEach((tc, i) => {
        (get(tc.function.name)?.mutates ? serial : parallelizable).push(i);
      });

      await Promise.all(
        parallelizable.map(async (i) => {
          results[i] = await runTool(toolCallsToRun![i]!);
        }),
      );
      for (const i of serial) {
        results[i] = await runTool(toolCallsToRun[i]!);
      }

      // 回填按 tool_calls 原始顺序,与完成顺序无关——
      // 转录确定性比完成顺序重要(同样的对话重放应产生同样的 transcript)
      toolCallsToRun.forEach((tc, i) => {
        history.append({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: results[i]!,
        });
      });
    }

    process.stdout.write("\n"); // 一次对话(可能多轮)结束，换行分隔下一轮 prompt
  }
}
