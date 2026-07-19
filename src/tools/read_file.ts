import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

export const readFileDef: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "读取指定路径的本地文件内容并返回文本",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径，相对或绝对路径",
        },
      },
      required: ["path"],
    },
  },
};

export const readFileHandler: ToolHandler = async (args) => {
  const path = args?.path;
  // 守卫1：参数缺失
  if (!path) return "错误：缺少 path 参数";
  // 守卫2：读文件，失败返回错误字符串而非 throw
  try {
    // 先判断存在性，给出明确的"文件不存在"提示
    try {
      await access(path, constants.R_OK);
    } catch {
      return `错误：文件不存在 ${path}`;
    }
    return await readFile(path, "utf8");
  } catch (e) {
    return `错误：读取文件失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// 3. 打包成"工具"（把描述和函数绑一起，方便注册）
export const readFileTool = { def: readFileDef, handler: readFileHandler };
