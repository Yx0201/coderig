import { join } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import type { HistoryLine } from "../history/store.ts";
import { historyDir } from "../config/paths.ts";

// ===== search_history:让 agent 检索自己的历史对话转录 =====
//
// 转录(见 paths.ts 的 HISTORY_DIR)是无损事实层,全文远超上下文窗口,
// 所以给模型的不是"读全文"而是"关键词检索"——命中片段带 cid,
// 模型可据此追问更多细节(检索式长期记忆,而非全量注入)。

// 结果上限:检索工具自己不能成为撑爆 context 的源头
const MAX_MATCHES = 15;
const SNIPPET_LEN = 160;

export const searchHistoryDef: ToolDef = {
  type: "function",
  function: {
    name: "search_history",
    description:
      "搜索过去的对话历史记录(跨所有历史会话)。用于回忆之前对话里讨论过的决定、结论、文件改动等。" +
      "返回命中消息的会话id、角色和上下文片段。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要搜索的关键词或正则表达式",
        },
        cid: {
          type: "string",
          description: "只搜某个会话id(可选,默认搜全部历史会话)",
        },
        isRegex: {
          type: "boolean",
          description: "query 是否作为正则解释,默认 false(字面量匹配)",
        },
      },
      required: ["query"],
    },
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 命中位置周边截片段:保留匹配词前后文,首尾加省略号标记
function snippet(text: string, re: RegExp): string {
  const m = re.exec(text);
  const at = m?.index ?? 0;
  const start = Math.max(0, at - Math.floor(SNIPPET_LEN / 3));
  const s = text.slice(start, start + SNIPPET_LEN).replace(/\n/g, " ");
  return `${start > 0 ? "…" : ""}${s}${start + SNIPPET_LEN < text.length ? "…" : ""}`;
}

export const searchHistoryHandler: ToolHandler = async (args) => {
  const query = args?.query;
  if (!query) return "错误：缺少 query 参数";
  const onlyCid: string | undefined = args?.cid;
  const isRegex = !!args?.isRegex;

  let re: RegExp;
  try {
    re = new RegExp(isRegex ? query : escapeRegExp(query), "i");
  } catch (e) {
    return `错误：无效的正则 ${e instanceof Error ? e.message : String(e)}`;
  }

  // Bun.file(dir).exists() 对目录返回 false,不能用它判断目录存在;
  // 用 Bun.Glob.scan 探测,目录不存在会抛 ENOENT
  let historyDirExists = false;
  try {
    await Array.fromAsync(new Bun.Glob("*").scan({ cwd: historyDir(), onlyFiles: true }));
    historyDirExists = true;
  } catch {
    historyDirExists = false;
  }
  if (!historyDirExists) return "没有任何历史对话记录";

  try {
    let files = (
      await Array.fromAsync(new Bun.Glob("*.jsonl").scan({ cwd: historyDir() }))
    ).filter((f) => f.endsWith(".jsonl"));
    if (onlyCid) {
      files = files.filter((f) => f === `${onlyCid}.jsonl`);
      if (files.length === 0) return `错误：会话不存在 ${onlyCid}`;
    }
    // 文件名即 cid(ISO 时间戳),倒序遍历 = 从最近的会话开始搜
    files.sort().reverse();

    const out: string[] = [];
    let total = 0;
    for (const f of files) {
      if (total >= MAX_MATCHES) break;
      const cid = f.replace(/\.jsonl$/, "");
      let raw: string;
      try {
        raw = await Bun.file(join(historyDir(), f)).text();
      } catch {
        continue; // 单文件读失败跳过,不让整个搜索崩
      }
      const hits: string[] = [];
      let idx = 0; // 消息序号(仅 msg 行计数),供人对照转录定位
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let obj: HistoryLine;
        try {
          obj = JSON.parse(line) as HistoryLine;
        } catch {
          continue;
        }
        if (obj.kind !== "msg") continue;
        idx++;
        // 搜索面要包含 tool_calls:"我之前往哪个文件写了什么"这类问题,
        // 答案在 arguments 里而不在 content 里(assistant 调工具时 content 常为空)
        const calls = (obj.tool_calls ?? [])
          .map((t) => `${t.function.name}(${t.function.arguments})`)
          .join(" ");
        const content = calls
          ? `${obj.content ?? ""}${obj.content ? " " : ""}[调用工具: ${calls}]`
          : (obj.content ?? "");
        if (!re.test(content)) continue;
        hits.push(`  #${idx} [${obj.role}] ${snippet(content, re)}`);
        total++;
        if (total >= MAX_MATCHES) break;
      }
      if (hits.length) {
        out.push(`会话 ${cid} (${hits.length} 处命中):`);
        out.push(...hits);
      }
    }

    if (out.length === 0) return `历史对话中未找到匹配 ${query} 的内容`;
    if (total >= MAX_MATCHES)
      out.push(`... (已达 ${MAX_MATCHES} 条上限,可加 cid 参数缩小范围)`);
    return out.join("\n");
  } catch (e) {
    return `错误：搜索历史失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const searchHistoryTool = {
  def: searchHistoryDef,
  handler: searchHistoryHandler,
};
