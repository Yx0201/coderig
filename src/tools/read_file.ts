import { resolve } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { sha256 } from "./snapshot.ts";

// 默认一次读多少行:覆盖大多数"读一段确认内容"的探索场景,
// 又不会像全量读那样把大文件(如 logs/trace.jsonl)整个塞进 context(曾经一次把上下文撑大 5 倍)。
// 注意:分页只省"读一半就够"的场景;总结类任务必须全文进 context 是客观定律,靠上下文压缩兜,不靠分页。
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000; // 上限:防止模型自己要求读太多,堵住分页的初衷

// 二进制检测:取文件头部 8KB 字节,含 NUL 或非打印字节占比 >30% 视为二进制。
// 按字节判(评审 P1-8):Bun.file().text() 会把无效字节替换成 U+FFFD(有损解码),
// 可能漏判"不含 NUL 但无效字节多"的压缩/图片格式;且大二进制不该整个 text() 进内存
const BINARY_SCAN = 8192;
const NON_PRINTABLE_RATIO = 0.3;

function looksBinaryBytes(head: Uint8Array): boolean {
  if (head.includes(0)) return true; // NUL 字节
  let nonPrintable = 0;
  for (const b of head) {
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) nonPrintable++;
  }
  return nonPrintable / head.length > NON_PRINTABLE_RATIO;
}

export const readFileDef: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "读取指定文件,带行号、可分页。适用:看代码内容、确认文件当前状态、拿行号作为 edit_file 的锚点。" +
      "不适用:按内容找某段代码在哪(用 grep)、按文件名找路径(用 glob)。" +
      "默认一次读 " +
      DEFAULT_LIMIT +
      " 行(从 offset 起);文件更大时会标注剩余行数,用更大的 offset 续读。" +
      "需要全量读取(如做全文总结)时显式传大 limit。行号同时是 edit_file 行号编辑模式的锚点。" +
      "二进制文件会被检测并拒绝输出乱码。",
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
      additionalProperties: false,
    },
  },
};

export const readFileHandler: ToolHandler = async (args, ctx) => {
  const path = args?.path;
  if (!path) return "错误：缺少 path 参数";
  const offset = Math.max(1, Math.floor(args?.offset ?? 1));
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(args?.limit ?? DEFAULT_LIMIT)),
  );

  try {
    // 二进制检测:先只读头部字节(评审 P1-8)。text() 有损解码会漏判,
    // 且大二进制不该整个拉进内存
    const head = new Uint8Array(
      await Bun.file(path).slice(0, BINARY_SCAN).arrayBuffer(),
    );
    if (looksBinaryBytes(head))
      return `错误：${path} 是二进制文件(含 NUL 或大量不可打印字节),已跳过内容输出`;
    const content = await Bun.file(path).text();
    const lines = content.split("\n");
    // 文件若以 \n 结尾,split 会多出一个末尾空串,视觉上不算一行,去掉
    if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;

    if (offset > total) {
      return (
        `读取 ${path} · 共 ${total} 行\n` +
        `错误：offset(${offset}) 超出文件总行数,无内容可读。` +
        `若文件确实很大:按内容定位用 grep,或把 limit 调大从 offset=1 续读`
      );
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
    // 成功读到内容才算"读过"(评审 P1-7):空读(offset 越界)不能记指纹,
    // 否则 write_file 全量覆写会被 read-before-write 门误放行
    const abs = resolve(path);
    ctx.fileStates.set(abs, { hash: sha256(content) });
    ctx.readPaths.add(abs);
    return `${header}\n${body}${tail}`;
  } catch (e: any) {
    if (e?.code === "ENOENT") return `错误：文件不存在 ${path}`;
    return `错误：读取文件失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const readFileTool = { def: readFileDef, handler: readFileHandler };
