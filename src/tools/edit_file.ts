import { readFile, writeFile } from "node:fs/promises";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

export const editFileDef: ToolDef = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "对已存在文件做局部修改：将文件中【唯一出现的】oldString 替换为 newString。" +
      "用于精确修改文件中的某一段，保留其余内容不变。若文件不存在或 oldString 找不到则失败。" +
      "oldString 必须能在文件中精确匹配到，且最好足够独特以避免多处误匹配。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要修改的文件路径，相对当前工作目录或绝对路径",
        },
        oldString: {
          type: "string",
          description: "要被替换的原文片段，必须在文件中唯一存在",
        },
        newString: {
          type: "string",
          description: "替换后的新文本片段",
        },
      },
      required: ["path", "oldString", "newString"],
    },
  },
};

export const editFileHandler: ToolHandler = async (args) => {
  const path = args?.path;
  const oldString = args?.oldString;
  const newString = args?.newString;
  if (!path) return "错误：缺少 path 参数";
  if (oldString === undefined || oldString === null)
    return "错误：缺少 oldString 参数";
  if (newString === undefined || newString === null)
    return "错误：缺少 newString 参数";

  try {
    const content = await readFile(path, "utf8");

    // oldString 必须唯一，否则多处匹配时无法确定改哪处，拒绝执行避免误伤
    const first = content.indexOf(oldString);
    if (first === -1) {
      return `错误：文件中未找到该 oldString 片段，请检查内容是否完全一致(含缩进/空白)`;
    }
    const last = content.lastIndexOf(oldString);
    if (first !== last) {
      return `错误：oldString 在文件中多处出现(${first}, ${last})，无法确定修改哪处，请提供更长的唯一片段`;
    }

    const next =
      content.slice(0, first) +
      newString +
      content.slice(first + oldString.length);
    await writeFile(path, next, "utf8");
    return `已修改 ${path}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT")) return `错误：文件不存在 ${path}`;
    return `错误：修改文件失败 ${msg}`;
  }
};

export const editFileTool = { def: editFileDef, handler: editFileHandler };
