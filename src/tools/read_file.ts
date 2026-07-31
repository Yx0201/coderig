import type { ToolDef, ToolHandler } from "../llm/types.ts";

// 默认一次读多少行:覆盖大多数"读一段确认内容"的探索场景,
// 又不会像全量读那样把大文件(如 logs/trace.jsonl)整个塞进 context(曾经一次把上下文撑大 5 倍)。
// 注意:分页只省"读一半就够"的场景;总结类任务必须全文进 context 是客观定律,靠上下文压缩兜,不靠分页。
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000; // 上限:防止模型自己要求读太多,堵住分页的初衷

export const readFileDef: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "读取指定文件,带行号、可分页。默认一次读 " +
      DEFAULT_LIMIT +
      " 行(从 offset 起);文件更大时会标注剩余行数,用更大的 offset 续读。" +
      "行号同时是 edit_file 行号编辑模式的锚点。需要全量读取(如做全文总结)时显式传大 limit。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径,相对或绝对路径",
        },
        offset: {
          type: "number",
          description: "起始行号(从 1 开始),默认 1",
        },
        limit: {
          type: "number",
          description: `本次读取的行数,默认 ${DEFAULT_LIMIT},最大 ${MAX_LIMIT}`,
        },
      },
      required: ["path"],
    },
  },
};

export const readFileHandler: ToolHandler = async (args) => {
  const path = args?.path;
  if (!path) return "错误：缺少 path 参数";
  const offset = Math.max(1, Math.floor(args?.offset ?? 1));
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(args?.limit ?? DEFAULT_LIMIT)),
  );

  try {
    const content = await Bun.file(path).text();
    const lines = content.split("\n");
    // 文件若以 \n 结尾,split 会多出一个末尾空串,视觉上不算一行,去掉
    if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;

    if (offset > total) {
      return `读取 ${path} · 共 ${total} 行\n错误：offset(${offset}) 超出文件总行数,无内容可读`;
    }
    const end = Math.min(offset + limit - 1, total);
    const slice = lines.slice(offset - 1, end);
    const width = String(end).length;
    const body = slice
      .map((l, i) => `${String(offset + i).padStart(width)}: ${l}`)
      .join("\n");
    const header = `读取 ${path} · 共 ${total} 行 · 本次 ${offset}-${end}`;
    // 截断标记:被截断了必须告诉模型还剩多少、怎么续读——静默截断会让模型误以为读到了全文
    const tail =
      end < total
        ? `\n…(还有 ${total - end} 行,用 offset=${end + 1} 续读)`
        : "";
    return `${header}\n${body}${tail}`;
  } catch (e: any) {
    if (e?.code === "ENOENT") return `错误：文件不存在 ${path}`;
    return `错误：读取文件失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const readFileTool = { def: readFileDef, handler: readFileHandler };
