import type { ChatMessage } from "../llm/types.ts";

// ===== 上下文管理(纯逻辑,不碰 LLM/磁盘) =====
//
// 分层原则:转录(store.ts 落盘)是无损事实层,永不修改;
// 这里只负责从原始 msgs 组装"发送视图"——一个受窗口约束的有损投影。
// 视图 = [摘要消息(若压缩过)] + 尾部原文(旧的大工具结果/超长工具参数被裁剪成占位符)。

// 模型上下文窗口预算(token)。ollama 的 num_ctx 往往远小于模型标称窗口,按实际配置填
export const CONTEXT_WINDOW_TOKENS = Number(
  process.env.CONTEXT_WINDOW_TOKENS || 8192,
);
// 压缩触发阈值:不贴着窗口上限,80% 就触发——既留输出空间,也避开长上下文注意力稀释区
export const COMPACT_THRESHOLD = 0.8;

// 压缩状态:cutIndex 之前的消息已被 summary 替代(索引指向原始 msgs 数组)
export interface CompactionState {
  cutIndex: number;
  summary: string;
}

// 压缩时保留的尾部原文预算(字符,粗略对应 2~3k token)。
// 用字符而非 token:切点只需大致准确,真实触发信号始终是 API 返回的 prompt_tokens
const TAIL_KEEP_CHARS = 6000;
// 尾部硬下界:无论预算怎么算,至少留这么多条原文在 tail 里。
// 对齐 Anthropic context editing 的 keep 语义——只按体积算切点的话,
// 一条超大消息(读了个大文件、或用户粘了长报错)自己就能吃满预算,
// 导致切点推到数组末尾、tail 为空,模型只看到摘要看不到当前工作现场
const MIN_TAIL_MSGS = 6;
// 视图裁剪:最近 N 条消息完整保留,更早的大工具结果换成占位符
const KEEP_RECENT = 8;
// 旧工具结果超过该字符数才裁剪(小结果留着,裁了省不了几个 token 反而丢信息)
const TOOL_TRIM_MIN = 400;
// 旧 assistant 消息里单条 tool_calls.arguments 超过该长度才处理。
// 对齐 Anthropic context editing 的 clear_tool_inputs 语义,但更保守:
// 大多数工具参数很短(路径/pattern),清了省不了几个 token 还丢行动记录;
// 只有 write_file.content 这类携带全文的超长参数才值得裁
const ARGS_TRIM_MIN = 400;
// 参数对象里单个字符串字段超过该长度才置换(path 等短字段原样保留)
const ARG_FIELD_MAX = 200;

// 裁剪一条超长的 arguments:解析 JSON 后逐字段处理——短字段保留(行动痕迹),
// 长字段换占位符(内容已落到文件系统,read_file 可取回当前状态,陈旧快照不值得占窗口)。
// 解析失败(模型产出过非法 JSON)则整串截断兜底,保证视图里永远是有限长度
function trimToolCallArgs(argsStr: string): string {
  try {
    const obj = JSON.parse(argsStr);
    if (typeof obj !== "object" || obj === null) throw new Error("非对象参数");
    for (const k of Object.keys(obj)) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length > ARG_FIELD_MAX) {
        (obj as Record<string, unknown>)[k] =
          `[已裁剪:原 ${v.length} 字符,内容已生效,如需查看请用工具重新获取]`;
      }
    }
    return JSON.stringify(obj);
  } catch {
    return `${argsStr.slice(0, ARG_FIELD_MAX)}...[已裁剪:原 ${argsStr.length} 字符]`;
  }
}

// 触发判断:用上一轮 API 返回的真实 prompt_tokens,不做本地估算(分词器不一致,估不准)
export function shouldCompact(promptTokens: number): boolean {
  return promptTokens > CONTEXT_WINDOW_TOKENS * COMPACT_THRESHOLD;
}

// 一条消息在上下文里的实际体积(字符)。必须把 tool_calls.arguments 算进去——
// write_file 的 content 是整个文件全文,只数 content 字段的话最大的 token 消耗者
// 在切点核算里记 0,压缩会以为"尾部很短"从而压不到东西
function msgChars(m: ChatMessage | undefined): number {
  if (!m) return 0;
  let n = m.content?.length ?? 0;
  for (const tc of m.tool_calls ?? []) {
    n += tc.function.name.length + tc.function.arguments.length;
  }
  return n;
}

// 选压缩切点:从末尾往前累计字符,超出尾部预算处即为候选切点,再夹到两个安全边界内:
// 1) 尾部至少留 MIN_TAIL_MSGS 条原文——只按体积算的话一条超大消息就能吃满预算,
//    把切点推到数组末尾、tail 变空,模型丢掉当前工作现场(读大文件后必然发生);
// 2) tool 消息不能当 tail 首条(会与它的 assistant(tool_calls) 拆开,
//    违反"每个 tool 消息前必须有对应 assistant"的协议约束)。
// 返回值 <= prevCut 表示"无可压的增量",由调用方跳过本次压缩
export function pickCutIndex(
  msgs: readonly ChatMessage[],
  prevCut: number,
): number {
  // 尾部下界:留够 MIN_TAIL_MSGS 条,切点不能越过这条线
  const maxCut = msgs.length - MIN_TAIL_MSGS;
  if (maxCut <= prevCut) return prevCut; // 尾部本身就没超过下界,没什么可压

  let cut = prevCut + 1; // 至少压掉一条,保证每次压缩有进展
  let acc = 0;
  for (let i = msgs.length - 1; i > prevCut; i--) {
    acc += msgChars(msgs[i]);
    if (acc > TAIL_KEEP_CHARS) {
      cut = i + 1;
      break;
    }
  }
  cut = Math.min(cut, maxCut); // 先夹下界
  // 再推过 tool 消息保协议。这一步可能越过 maxCut 一两条——
  // 协议正确性优先于尾部条数,宁可多压一条也不能留下孤儿 tool
  while (cut < msgs.length && msgs[cut]?.role === "tool") cut++;
  return Math.min(cut, msgs.length);
}

// 组装发送视图:压缩状态 + 原始消息 → 实际传给 sendMessages 的数组。
// 每次调用现算,不缓存——msgs 和压缩状态都可能变,视图必须永远反映最新事实
export function buildContextView(
  msgs: readonly ChatMessage[],
  compaction: CompactionState | null,
): ChatMessage[] {
  let from = compaction?.cutIndex ?? 0;
  // 防御:tail 不能以 tool 消息开头(它的 assistant(tool_calls) 已被压掉,
  // 违反"每个 tool 消息前必须有对应 assistant"的协议约束)。pickCutIndex 已保证这点,
  // 但 cutIndex 也可能来自旧版本转录里的 compaction 行,这里再兜一次
  while (from < msgs.length && msgs[from]?.role === "tool") from++;
  const tail = msgs.slice(from);
  const keepFrom = Math.max(0, tail.length - KEEP_RECENT);
  const view = tail.map((m, i) => {
    // 最近的消息原样保留(当前任务的工作现场)
    if (i >= keepFrom) return m;
    // 旧 assistant 消息:正文(对话主干)不动,只裁 tool_calls 里的超长 arguments
    // (write_file 的 content 是整个文件全文,不裁则每轮都原样重发,是 context 最大头)
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (!m.tool_calls.some((tc) => tc.function.arguments.length > ARGS_TRIM_MIN))
        return m;
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) =>
          tc.function.arguments.length > ARGS_TRIM_MIN
            ? {
                ...tc,
                function: {
                  ...tc.function,
                  arguments: trimToolCallArgs(tc.function.arguments),
                },
              }
            : tc,
        ),
      };
    }
    // 旧 tool 大结果:裁剪但保留首行(操作摘要)
    if (m.role !== "tool") return m;
    if ((m.content?.length ?? 0) <= TOOL_TRIM_MIN) return m;
    // 裁剪时保留首行:文件类工具(read_file/write_file/edit_file)首行即操作摘要
    // ("已修改 path (改动起始行 N)"等),留着就保住了行动痕迹(改过哪个文件/哪行)。
    // bash/grep 首行只是 stdout/首条命中,留下的是碎片——但下面的占位符已写明
    // "如需完整内容请重新调用工具",模型不会误以为这就是全部。
    // 内容细节一律可丢:文件系统才是当前状态的事实源,重新读取比信任陈旧快照可靠
    const firstLine = (m.content.split("\n", 1)[0] ?? "").slice(0, 200);
    return {
      ...m,
      content: `${firstLine}\n[其余 ${m.content.length - firstLine.length} 字符已裁剪:${m.name ?? "?"} 的旧结果。如需完整内容,请重新调用工具获取当前状态]`,
    };
  });
  if (compaction) {
    view.unshift({
      role: "user",
      content: `[历史对话摘要——以下是本对话更早内容的压缩总结,原文已省略]\n${compaction.summary}`,
    });
  }
  return view;
}
