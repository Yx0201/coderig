import type { ChatMessage, ToolCall } from "../llm/types.ts";
import { sendMessages } from "../llm/client.ts";
import { createTerm, isCancel, type Term } from "./tui/term.ts";
import { get, listDefs, type ToolEntry } from "../tools/registry.ts";
import { checkPermission, classifyBash } from "../tools/permissions.ts";
import { planGuardViolation } from "../tools/plan_mode.ts";
import { Tracer } from "../observability/tracer.ts";
import { resolveSystemPrompt, runtimeReminder } from "../prompts/system.ts";
import { History } from "../history/store.ts";
import {
  shouldCompact,
  hasOversizedMsg,
  contextWindowTokens,
} from "../history/context.ts";
import { isDoomLoop, type CallSig } from "./doom_loop.ts";
import { createSessionContext } from "../tools/context.ts";
import { partitionToolCalls, buildWaves, FileLocks } from "../tools/partition.ts";
import { SnapshotStore } from "../tools/snapshot.ts";
import { snapshotDir, plansDir } from "../config/paths.ts";
import { loadSettings, addPermission } from "../config/settings.ts";
import { resolve, sep } from "node:path";
import { gcStateDir } from "../tools/gc.ts";

const tracer = new Tracer();

// 续话:传一个已有 cid,把那段对话的转录灌回内存接着聊;
// 不传则新开一段对话。两种情况都各自记一份观测(trace 的新 sid),但 cid 跨续话保持不变
export async function startChat(resumeCid?: string) {
  // 不再每次清空 trace:骨架阶段已过,进入 sysprompt A/B 阶段,
  // 日志跨运行累积,靠每条事件的 sid 切出单次运行做前后对比(见 CLAUDE.md 观测约定)
  // 惰性 GC tmp/ 与 snapshots/(评审 P1-10):fire-and-forget,不阻塞启动
  void gcStateDir();
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
  const term = createTerm({ tracer });
  term.notify(
    resumeCid
      ? `welcome back! 续话 ${history.cid} (${history.messages.length} 条历史消息)\n`
      : `welcome to the chat! 新对话 ${history.cid}\n`,
  );
  term.setStatus(model);
  // 配置级权限(settings.json):allow 种子进会话放行名单,deny 既硬禁止又从模型可见列表隐藏。
  // 会话级放行名单:用户在确认提示里选"本会话不再询问 X"时加入。
  // 只记工具名粒度(bash/write_file/edit_file);危险命令与敏感路径不可放行,
  // 由 permissions.ts 的 rememberable=false 保证进不了这个集合
  const settings = await loadSettings();
  const sessionAllows = new Set<string>(settings.permissions.allow);
  const denyTools = new Set<string>(settings.permissions.deny);
  // 会话级工具状态(冲突检测/read-before-write/todo/快照),按对话 cid 分组快照——
  // 续话时同一段对话共享快照,恢复时也按 cid 找
  const snapshotStore = new SnapshotStore(snapshotDir(), history.cid);
  const ctx = createSessionContext({
    snapshot: (path) => snapshotStore.snapshot(path),
    // 审批 UI 钩子:exit_plan_mode 提交计划时弹确认,用户批准才切回正常模式。
    // 实现交给 term(Linear 用 Clack p.confirm,TUI 用帧内模态),语义都是 "批准才返回 true"
    confirm: (msg) => term.confirm(msg),
  });

  // 收尾轮:不带 tools 发最后一轮请求,模型只能输出文本。
  // 用于"达到轮数上限"和"检测到死循环且用户选择停止"两种异常收尾——
  // 硬停会把半截工作甩给用户,opencode 的做法是让模型自己交代
  // 做到哪了、剩什么、建议下一步,信息价值天差地别
  const finalSummaryRound = async (reason: string) => {
    tracer.error(`进入收尾轮: ${reason}`);
    term.notify(`\n⊘ ${reason},让模型总结当前进度…\n`, "dim");
    history.append({
      role: "user",
      content:
        `[harness] ${reason}。工具调用已被禁用,不要再尝试调用任何工具。` +
        `请用纯文本总结:1) 已完成了什么 2) 什么还没做完 3) 建议用户下一步怎么做。`,
    });
    term.start();
    let summary = "";
    try {
      for await (const event of sendMessages(history.contextMessages)) {
        // 不传 tools:模型想继续调工具也调不了(协议层禁用,不靠提示词自觉)
        if (event.type === "content") {
          term.onContent(event.text); // onContent 内部已幂等停 spinner
          summary += event.text;
        }
      }
    } catch (err) {
      term.end(); // 收尾:定格 spinner + 把已流出的半截内容落定(漏调会留在 live 区串到下一轮)
      tracer.error(
        `收尾轮请求失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      term.error("收尾轮也失败了,本轮工作到此为止");
      return;
    }
    term.end(); // 流正常结束:live 区的总结落定进历史块
    if (summary.trim()) {
      history.append({ role: "assistant", content: summary });
    }
    term.notify("");
  };

  while (true) {
    const input = await term.promptInput();

    if (isCancel(input)) {
      // 顺序要紧:先卸载 TUI 恢复终端,再打汇总/告别 —— 反过来的话这两行会被塞进
      // 已经不再渲染的 Ink 帧里(store 在 shutdown 后把提示直写 stdout,见 TuiStore.pushNotice)
      term.shutdown();
      tracer.endSession();
      term.notify("Bey~\n");
      break;
    }

    if (!input.trim()) continue;
    history.append({ role: "user", content: input });
    term.showUser(input); // TUI 回卷里显示用户一问;linear no-op
    tracer.userMessage(input); // 记录用户本轮的输入(点事件)

    let rounds = 0;
    // 轮数上限:codex 完全不设限、opencode 默认无限、gemini-cli 用 100。
    // 之前的 10 轮硬顶会腰斩正常的长任务(一次真实重构轻松超过 10 轮工具调用)。
    // 但云端 API 按 token 计费,失控循环是真金白银,不能照搬 codex 的"不设限"——
    // 取一个"正常任务到不了、失控循环烧不光"的中间值,MAX_AGENT_ROUNDS 可覆盖。
    // 注意:超限后不是硬停,而是走收尾轮(见 finalSummaryRound)
    const MAX_ROUNDS = Number(process.env.MAX_AGENT_ROUNDS || 50);
    // 连续空回答计数:模型本轮无 content 也无 tool_calls 时 +1,有产出时归零。
    // 防止对"只想不答"的模型无限 nudge。超过上限就明确放弃,而不是静默结束
    let emptyRounds = 0;
    const MAX_NUDGE = 2; // 最多续轮 2 次,再不答就放弃
    // nudge 文本:塞回 history 当一条 user 消息,把模型从"只想不说"拉回"给出回答或行动"
    const NUDGE_TEXT =
      "你上一轮只输出了思考,没有给出最终回答,也没有调用工具。请直接用正文回答用户,或调用工具继续完成任务。";
    // doom loop 检测的调用序列:本用户回合内所有已执行的工具调用(按执行顺序)。
    // 检测逻辑在 doom_loop.ts(纯函数,可单测)
    const recentCalls: CallSig[] = [];
    while (true) {
      rounds++;
      if (rounds > MAX_ROUNDS) {
        await finalSummaryRound(`达到最大轮数 ${MAX_ROUNDS}`);
        break;
      }
      tracer.nextRound();
      tracer.llmStart();
      let answer = "";
      let reasoning = ""; // 本轮推理原文:带 tool_calls 的 assistant 消息必须原样存回 history
      term.start(); // 请求前启动"请求中" spinner(渲染状态机在 LinearTerm 内部)
      let toolCallsToRun: ToolCall[] | null = null;
      let contentLen = 0;
      let reasoningLen = 0;
      let currentUsage: any;
      let currentFinishReason: string | null = null; // 本轮 finish_reason,判停兜底用
      try {
        for await (const event of sendMessages(
          history.contextMessages, // 发送视图:压缩/裁剪后的投影,而非完整转录(见 history/context.ts)
          listDefs(denyTools), // 配置级 deny 的工具不给模型(visibleTools;空集时 listDefs 内部已处理)
          // 每轮注入运行时状态:模式(workflow 段)+ todo 清单(静态正文之外)
          {
            mode: ctx.state.mode,
            runtime: runtimeReminder(ctx.state.mode, ctx.todos),
          },
        )) {
          // ===== 渲染全部委托给 term:reasoning/content/retry/进度 按 delta 增量喂,
          //     内部管 spinner / 光标 / 进度行;usage/finish/tool_calls 只记状态;raw 落盘。
          //     思考原文仍在此全量累积进 reasoning(DeepSeek 协议硬要求),显示层另走 term
          switch (event.type) {
            case "content":
              term.onContent(event.text);
              answer += event.text;
              contentLen += event.text.length;
              break;
            case "reasoning":
              term.onReasoning(event.text);
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
              // 云端 API 抖动,client 层退避后将自动重发。落盘由 tracer 处理,终端提示交给 term
              tracer.retry(event);
              term.onRetry(event);
              break;
            case "tool_call_progress":
              term.onToolCallProgress(event.name, event.argsChars);
              break;
          }
        }
        // 流正常结束(可能只吐了 reasoning):收尾 spinner(思考态定格 / 兜底停)
        term.end();
        // 一轮流完,记一次 llm_end(本轮元信息 + usage + finish_reason),在循环外只调一次
        tracer.llmEnd({
          contentLen,
          reasoningLen,
          toolCallsCount: toolCallsToRun?.length ?? 0,
          finishReason: currentFinishReason,
          usage: currentUsage,
        });
        // header 实时刷新 token(TUI 固定头用;linear no-op)
        if (currentUsage) {
          term.setStatus(model, {
            prompt: currentUsage.prompt_tokens,
            completion: currentUsage.completion_tokens,
          });
        }
      } catch (err) {
        const msg = `请求失败: ${err instanceof Error ? err.message : String(err)}`;
        // 思考中途请求挂了:先定格思考行(错误信息不能压在转着的 spinner 上)
        term.end();
        tracer.error(msg); // 记错误事件
        term.error(msg);
        break; // 请求失败：跳出 agent loop，不执行工具、不保存半截回答
      } finally {
        // 兜底:无论走哪条路径,离开本轮时 spinner 一定不能还在转
        // (term.stop 幂等,已 end/已 stop 时是 no-op)
        term.stop();
      }

      // 上下文压缩检查:用本轮 API 返回的真实 prompt_tokens 对阈值(不做本地估算)。
      // 放在判停之前:无论下一步是续轮调工具还是等用户新输入,下次请求都用压缩后的视图,
      // 避免超阈值的大上下文再被原样发一次。压缩失败只记错降级继续,不能搞崩对话
      if (currentUsage && shouldCompact(currentUsage.prompt_tokens)) {
        // 压缩要调一次 LLM 生成摘要,可能几秒——先打一行,别让用户以为卡死
        term.notify("\n⊘ 正在压缩上下文(调用模型生成摘要)…\n", "dim");
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
          term.error("模型输出被截断,本轮无完整回答");
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
          term.error("模型多次未给出回答,已停止");
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

      // doom loop 检测(必须先于回填 assistant):把本轮调用并入序列,
      // 看末尾是否连续 N 次完全相同。在回填之前检测——若用户选择停止,
      // 带 tool_calls 的 assistant 根本没进转录,不会留下缺 tool 结果的孤儿
      recentCalls.push(
        ...toolCallsToRun.map((tc) => ({
          name: tc.function.name,
          args: tc.function.arguments,
        })),
      );
      if (isDoomLoop(recentCalls)) {
        const sig = recentCalls[recentCalls.length - 1]!;
        const choice = await term.select<"continue" | "stop">(
          `⚠ 检测到重复调用: ${sig.name} 已连续以相同参数调用多次,可能陷入死循环`,
          [
            { value: "continue", label: "继续(可能是合法重试)" },
            { value: "stop", label: "停止并让模型总结当前进度" },
          ],
        );
        const decision = isCancel(choice) || choice === "stop" ? "stop" : "continue";
        tracer.doomLoop({
          tool: sig.name,
          args: sig.args.slice(0, 200),
          decision,
        });
        if (decision === "stop") {
          await finalSummaryRound(`检测到死循环(${sig.name} 重复调用),已停止`);
          break;
        }
        // 用户选择继续:重置序列,给模型 N 次机会后再问一次,而不是每轮都问
        recentCalls.length = 0;
      }

      // [DeepSeek适配] 有工具调用:先回填 assistant(带 tool_calls + reasoning_content)。
      // reasoning_content 是 DeepSeek thinking 模式的硬协议:缺了它,
      // 下一轮请求直接 400——它不是"可选的思考记录",是请求报文的一部分。
      // 验证点:模型升级时确认 DeepSeek API 仍要求 thinking 原文回传;
      // 若改为服务端自存,此字段与回填逻辑一并删除
      history.append({
        role: "assistant",
        content: answer,
        tool_calls: toolCallsToRun,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });

      // 工具执行拆成两阶段(评审 P0-4):
      //   阶段1 审批:wave 内逐个调用串行决策(权限/plan 守卫/确认框),确认框不并发抢 TTY;
      //   阶段2 执行:已放行的调用并发跑 handler(仍按 path 加锁)。
      // tracer.toolCall 在阶段1 记开始,toolResult 在阶段2(或被拒时)记结束,
      // toolApproved 重锚定计时起点——审批耗时不算进工具耗时。

      // 拒绝文案(含工具级修复指引,参考 opencode CorrectedError 的 feedback 思路)
      const denialMessage = (
        toolName: string,
        reason: string,
        hardDeny: boolean,
      ): string => {
        const hint =
          hardDeny && toolName === "bash" && /rm\s|删除|删除命令/.test(reason)
            ? " 提示:删除不可逆,不要找替代命令重试;确实要清理就请用户手动执行。"
            : "";
        return (
          (hardDeny
            ? `错误：该操作被安全策略硬禁止(${reason})。请改用其它思路,或告知用户需要手动处理`
            : `错误：用户拒绝了本次操作。不要换种方式重试同一意图;请先在回复中说明你想做什么、征得用户同意后再继续`) +
          hint
        );
      };

      // 阶段1 审批:返回 allowed=false + result(被拒原因) 或 allowed=true + args + entry
      const approveToolCall = async (tc: ToolCall) => {
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
        tracer.toolCall(tc.function.name, args, tc.id); // 记开始,带 callId 供配对

        const entry = get(tc.function.name);
        if (!entry) return { allowed: false, result: `错误：未知工具 ${tc.function.name}` };

        // plan 模式写守卫(模式级约束高于工具权限)
        if (ctx.state.mode === "plan") {
          const violation = planGuardViolation(tc.function.name, args);
          if (violation) return { allowed: false, result: violation };
        }

        // 权限门:auto 直接放行;deny 硬禁;ask 弹确认(串行,不并发抢 TTY)
        const perm = checkPermission(tc.function.name, args, sessionAllows, denyTools);
        if (perm.action === "deny") {
          tracer.approval({
            tool: tc.function.name,
            action: "deny",
            decision: "deny",
            reason: perm.reason,
          });
          term.notify(`\n⛔ 已阻止: ${perm.reason}\n`, "red");
          return { allowed: false, result: denialMessage(tc.function.name, perm.reason, true) };
        }
        if (perm.action === "ask") {
          const choice = await term.select<"allow" | "session" | "persist" | "deny">(
            `⚠ 模型请求: ${perm.reason}`,
            [
              { value: "allow" as const, label: "允许一次" },
              ...(perm.rememberable
                ? [
                    { value: "session" as const, label: `本会话不再询问 ${tc.function.name}` },
                    // "总是允许"只给文件写工具,不给 bash——一次点击 = 所有命令永久免问,
                    // 授权范围远超用户预期(评审 P2-1)
                    ...(tc.function.name === "bash"
                      ? []
                      : [{ value: "persist" as const, label: "总是允许(写入配置)" }]),
                  ]
                : []),
              { value: "deny" as const, label: "拒绝" },
            ],
          );
          if (isCancel(choice) || choice === "deny") {
            tracer.approval({
              tool: tc.function.name,
              action: "ask",
              decision: "deny",
              reason: perm.reason,
            });
            return { allowed: false, result: denialMessage(tc.function.name, perm.reason, false) };
          }
          if (choice === "session") {
            sessionAllows.add(tc.function.name);
          } else if (choice === "persist") {
            // 写入 settings.json 跨会话持久放行。危险命令/敏感路径由
            // rememberable=false 保证不出现"总是允许"选项,到不了这里
            sessionAllows.add(tc.function.name);
            await addPermission("allow", tc.function.name);
          }
          tracer.approval({
            tool: tc.function.name,
            action: "ask",
            decision:
              choice === "session"
                ? "session_allow"
                : choice === "persist"
                  ? "persist_allow"
                  : "allow",
            reason: perm.reason,
          });
        }
        return { allowed: true, args, entry };
      };

      // 阶段2 执行:审批已放行,重锚定计时起点后并发跑 handler
      const executeToolCall = async (
        tc: ToolCall,
        args: any,
        entry: ToolEntry,
      ): Promise<string> => {
        // 审批耗时(含用户看确认框的时间)不算进工具耗时
        tracer.toolApproved(tc.id);
        // 慢工具提示:300ms 内跑完的不打扰(read_file 就几毫秒,提示反而是噪音);
        // 超过才打一行"执行中"(bash tsc 要几秒,静默期会让用户以为卡死)
        const slowTimer = setTimeout(() => {
          term.notify(`⏳ ${tc.function.name} 执行中…\n`, "dim");
        }, 300);
        let result: string;
        let ok: boolean;
        try {
          // 每调用一个 ctx 浅拷贝:fileStates/todos 等共享引用照常更新,
          // gate 重绑当前工具名,落 trace 时能区分哪个工具触发的拦截
          const runCtx = {
            ...ctx,
            gate: (
              info: { kind: "read_before_write" | "conflict"; path: string },
            ) => tracer.toolGate({ ...info, tool: tc.function.name }),
          };
          result = await entry.handler(args, runCtx);
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
        tracer.toolResult(tc.function.name, result, ok, tc.id);
        return result;
      };

      // 只读并行、写按调用内容细判(见 partition.ts):bash 只读命令可并行;
      // write/edit 按目标文件加锁(同文件互斥、异文件可并行);bash 非只读全局串行。
      // buildWaves 把"可并发批"组织好,批间顺序 = 模型给出的顺序,语义与串行版本一致。
      // 这是并行化引入的数据竞争,不是模型的问题,必须在 harness 层挡住
      const results = new Array<string>(toolCallsToRun.length);
      const fileLocks = new FileLocks();
      const waves = buildWaves(partitionToolCalls(toolCallsToRun, get));
      for (const wave of waves) {
        // 阶段1:串行审批(确认框逐个弹,不并发抢 TTY——评审 P0-4)
        const approvals: {
          allowed: boolean;
          result?: string;
          args?: any;
          entry?: ToolEntry;
        }[] = [];
        for (const { toolCall } of wave) {
          const a = await approveToolCall(toolCall);
          if (!a.allowed) {
            tracer.toolResult(toolCall.function.name, a.result!, false, toolCall.id);
          }
          approvals.push(a);
        }
        // 阶段2:并发执行已放行的调用(仍按 path 加锁)
        await Promise.all(
          wave.map(async ({ index, toolCall, kind, lockPath }, i) => {
            const a = approvals[i]!;
            if (!a.allowed) {
              results[index] = a.result!;
              return;
            }
            const exec = () =>
              executeToolCall(toolCall, a.args!, a.entry!).then((r) => {
                results[index] = r;
              });
            // 写工具按绝对路径加锁:"src/a.ts" 与 "./src/a.ts" 才能互斥
            return kind === "file_lock" && lockPath
              ? fileLocks.withLock(resolve(lockPath), exec)
              : exec();
          }),
        );
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

    term.notify(""); // 一次对话(可能多轮)结束，换行分隔下一轮 prompt
  }

  // 唯一的退出路径(cancel 分支 break 到这里):TUI 模式卸载 Ink、恢复终端
  term.shutdown();
}
