import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { readdir } from "node:fs/promises";

export const listDirDef: ToolDef = {
  type: "function",
  function: {
    name: "list_dir",
    description:
      "列出指定目录下的文件和子目录，可选递归。用于了解项目结构、探索文件位置",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径，相对当前工作目录或绝对路径，默认当前目录",
        },
        recursive: {
          type: "boolean",
          description: "是否递归列出子目录内容，默认 false",
        },
      },
      required: [],
    },
  },
};

export const listDirHandler: ToolHandler = async (args) => {
  const path = args?.path || ".";
  const recursive = !!args?.recursive;
  try {
    const entries = await readdir(path, { withFileTypes: true, recursive });
    return entries
      .map(
        (e) =>
          `${e.isDirectory() ? "d" : "f"} ${e.parentPath ? e.parentPath + "/" : ""}${e.name}`,
      )
      .join("\n");
  } catch (e) {
    return `错误：列目录失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// 3. 打包成"工具"（把描述和函数绑一起，方便注册）
export const listDirTool = { def: listDirDef, handler: listDirHandler };
