import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

export const writeFileDef: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "创建或整体覆写一个文件。内容会被完整写入，若文件已存在则旧内容被完全替换。" +
      "用于新建文件，或确认要全量替换旧内容时。局部修改请用 edit_file。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径，相对当前工作目录或绝对路径",
        },
        content: {
          type: "string",
          description: "要写入文件的完整内容",
        },
      },
      required: ["path", "content"],
    },
  },
};

export const writeFileHandler: ToolHandler = async (args) => {
  const path = args?.path;
  const content = args?.content;
  if (!path) return "错误：缺少 path 参数";
  if (content === undefined || content === null)
    return "错误：缺少 content 参数";

  try {
    // 若父目录不存在则自动创建，方便在新建嵌套路径文件时一步到位
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return `已写入 ${path} (${content.length} 字符)`;
  } catch (e) {
    return `错误：写入文件失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// mutates:写文件改外部状态,不能与其它写并行(见 registry.ts)
export const writeFileTool = {
  def: writeFileDef,
  handler: writeFileHandler,
  mutates: true,
};
