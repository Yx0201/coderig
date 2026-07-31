import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { readdir } from "node:fs/promises";
import { isIgnoredPath } from "./ignore.ts";

// 结果上限:递归列大目录(如 node_modules 的父目录)能出几千行,
// 和 glob 一样会撑爆 context。超出截断并提示改用 glob 定向找文件
const MAX_ENTRIES = 500;

export const listDirDef: ToolDef = {
  type: "function",
  function: {
    name: "list_dir",
    description:
      "列出指定目录下的文件和子目录,可选递归。适用:快速了解项目结构、看某目录下有什么。" +
      "不适用:按文件名在任意层级找文件(用 glob 的 ** 模式)。" +
      "默认只列一层(不递归);要看清整体结构再设 recursive。了解结构时建议先不递归看一层,再逐层深入。" +
      `结果超过 ${MAX_ENTRIES} 条会截断。`,
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
      additionalProperties: false,
    },
  },
};

export const listDirHandler: ToolHandler = async (args) => {
  const path = args?.path || ".";
  const recursive = !!args?.recursive;
  try {
    const entries = await readdir(path, { withFileTypes: true, recursive });
    // 过滤 node_modules 与 VCS 目录(共享规则,见 ignore.ts),避免条目里全是噪音(评审 P1-6)
    const lines = entries
      .filter((e) => {
        const rel = e.parentPath ? `${e.parentPath}/${e.name}` : e.name;
        return !isIgnoredPath(rel);
      })
      .map(
        (e) =>
          `${e.isDirectory() ? "d" : "f"} ${e.parentPath ? e.parentPath + "/" : ""}${e.name}`,
      );
    if (lines.length > MAX_ENTRIES) {
      return (
        lines.slice(0, MAX_ENTRIES).join("\n") +
        `\n...(条目过多,共 ${lines.length} 条,仅显示前 ${MAX_ENTRIES} 条;找具体文件用 glob)`
      );
    }
    return lines.join("\n");
  } catch (e) {
    return `错误：列目录失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// 3. 打包成"工具"（把描述和函数绑一起，方便注册）
export const listDirTool = { def: listDirDef, handler: listDirHandler };
