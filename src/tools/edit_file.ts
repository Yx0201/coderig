import { resolve } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { sha256 } from "./snapshot.ts";

// 改动区回显的上下文行数:前后各几行,让模型看到改动落点的邻居,行号即下一轮编辑的锚点
const CONTEXT_LINES = 1;

export const editFileDef: ToolDef = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "对已存在文件做局部修改。适用:小范围改动(改一个函数/一段逻辑),比 write_file 省 token 且不易误伤。" +
      "不适用:新建文件、要整文件替换内容(用 write_file)。" +
      "编辑前必须先 read_file 读取该文件(harness 强制);文件在读取后被外部改过会被拒绝,需重读。" +
      "两种模式二选一:" +
      "(1) oldString/newString:把文件中【唯一出现的】oldString 替换为 newString,oldString 必须精确唯一匹配(含缩进/空白);" +
      "(2) start_line/end_line + newString:替换指定行号区间(行号从 read_file 获得),确定性锚点,无需复现精确文本。" +
      "成功后回显改动区及行号,作为下一轮编辑的锚点,避免靠记忆复现文本产生幻觉。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要修改的文件路径",
        },
        oldString: {
          type: "string",
          description: "模式1:要被替换的原文片段,必须在文件中唯一存在",
        },
        newString: {
          type: "string",
          description: "替换后的新文本(模式2 删除区间时传空字符串)",
        },
        start_line: {
          type: "number",
          description: "模式2:替换的起始行号(含,从 1 开始)",
        },
        end_line: {
          type: "number",
          description: "模式2:替换的结束行号(含)",
        },
      },
      required: ["path", "newString"],
      additionalProperties: false,
    },
  },
};

// 把若干行带行号格式化,供回显改动区用(与 read_file 的行号格式一致)
function formatRegion(lines: string[], from: number, to: number): string {
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    out.push(`${String(i).padStart(width)}: ${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

export const editFileHandler: ToolHandler = async (args, ctx) => {
  const path = args?.path;
  const newString = args?.newString ?? null;
  if (!path) return "错误：缺少 path 参数";
  if (newString === null) return "错误：缺少 newString 参数";

  try {
    const abs = resolve(path);
    // read-before-write 门:没读过就编辑,锚点从哪来?直接拦下让模型先读
    if (!ctx.readPaths.has(abs)) {
      ctx.gate({ kind: "read_before_write", path });
      return "错误：编辑前必须先 read_file 读取该文件的当前内容(拿到行号/内容作锚点),再执行 edit_file";
    }
    const content = await Bun.file(path).text();
    // 冲突检测:文件在会话读到之后被外部/其它工具改过(on-disk 指纹 ≠ 会话已知指纹),
    // 行号/oldString 都基于过期内容,拦下让模型重读
    const known = ctx.fileStates.get(abs);
    if (known && known.hash !== sha256(content)) {
      ctx.gate({ kind: "conflict", path });
      return "错误：文件自上次读取后已被修改(可能被外部或其它工具改动),请重新 read_file 拿到最新内容/行号后再编辑";
    }
    const trailingNl = content.endsWith("\n");

    let next: string;
    let regionStart: number; // 改动区起始行(1-based),用于回显锚点
    let regionLines: number; // 改动区新内容占几行

    if (args?.oldString !== undefined) {
      // ── 模式1:唯一匹配替换(保留原有的严格唯一校验,不放松)──
      const oldString = args.oldString;
      if (oldString === "")
        return "错误：oldString 不能为空(会处处匹配)";
      const first = content.indexOf(oldString);
      if (first === -1)
        return `错误：文件中未找到该 oldString 片段,请检查内容是否完全一致(含缩进/空白)`;
      const last = content.lastIndexOf(oldString);
      if (first !== last)
        return `错误：oldString 在文件中多处出现(${first}, ${last}),无法确定修改哪处,请提供更长的唯一片段`;
      next =
        content.slice(0, first) + newString + content.slice(first + oldString.length);
      // 改动区起始行 = oldString 起点之前有几个换行 +1
      regionStart = content.slice(0, first).split("\n").length;
      regionLines = newString.split("\n").length;
    } else if (args?.start_line !== undefined && args?.end_line !== undefined) {
      // ── 模式2:行号区间替换(确定性锚点,模型从 read_file 拿行号即可定位)──
      const start = Math.floor(args.start_line);
      const end = Math.floor(args.end_line);
      if (!Number.isFinite(start) || !Number.isFinite(end))
        return "错误：start_line/end_line 必须是数字";
      if (start < 1 || end < 1)
        return `错误：行号从 1 开始,收到 start=${start} end=${end}`;
      if (start > end)
        return `错误：start_line(${start}) 不能大于 end_line(${end})`;
      const lines = content.split("\n");
      if (content.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
      if (end > lines.length)
        return `错误：end_line(${end}) 超出文件总行数(${lines.length})`;
      // 删除区间时(newString 为空)不插入行;否则按行插入
      const insertLines = newString === "" ? [] : newString.split("\n");
      lines.splice(start - 1, end - start + 1, ...insertLines);
      next = lines.join("\n") + (trailingNl ? "\n" : "");
      regionStart = start;
      regionLines = insertLines.length;
    } else {
      return "错误：需提供 oldString(模式1)或 start_line+end_line(模式2),二选一";
    }

    // 写前快照:给"改错了可回滚"留底
    await ctx.snapshot(path);
    await Bun.write(abs, next);
    // 写成功 = 会话知道这份新内容,更新指纹与已读标记(连续编辑不被误判冲突)
    ctx.fileStates.set(abs, { hash: sha256(next) });
    ctx.readPaths.add(abs);

    // 回显改动区(带行号):给模型"操作后的新鲜锚点",下一轮编辑可直接用行号定位,不靠记忆
    const newLines = next.split("\n");
    if (next.endsWith("\n") && newLines[newLines.length - 1] === "")
      newLines.pop();
    const total = newLines.length;
    const showStart = Math.max(1, regionStart - CONTEXT_LINES);
    const showEnd = Math.min(
      total,
      regionStart + Math.max(0, regionLines - 1) + CONTEXT_LINES,
    );
    return `已修改 ${path} (改动起始行 ${regionStart})\n${formatRegion(newLines, showStart, showEnd)}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT")) return `错误：文件不存在 ${path}`;
    return `错误：修改文件失败 ${msg}`;
  }
};

// mutates:read-modify-write,并行两次改同一文件会互相覆盖(见 registry.ts)
export const editFileTool = {
  def: editFileDef,
  handler: editFileHandler,
  mutates: true,
};
