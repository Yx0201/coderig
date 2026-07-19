import fg from "fast-glob";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

export const globDef: ToolDef = {
  type: "function",
  function: {
    name: "glob",
    description:
      "按文件名模式递归搜索文件路径。**是最重要的通配符：**/文件名 能在任意层级目录下找到该文件。" +
      "例：'**/config.json' 在任意目录下找叫 config.json 的文件；'**/*.ts' 找所有 ts 文件；" +
      "'src/**/*.test.js' 在 src 下找所有测试文件。注意：不带 ** 的 pattern 如 'config.json' 只匹配当前目录、不会递归，几乎用不到。",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "匹配模式，用 ** 递归匹配任意层级目录。例：'**/config.json' 找所有叫 config.json 的文件；'**/*.ts' 找所有 ts 文件；'src/**/*.test.js' 在 src 下找所有测试文件",
        },
        path: { type: "string", description: "搜索的根目录，默认当前工作目录" },
      },
      required: ["pattern"],
    },
  },
};

export const globHandler: ToolHandler = async (args) => {
  const pattern = args?.pattern;
  if (!pattern) return "错误：缺少 pattern 参数";
  const cwd = args?.path || ".";
  try {
    const matches = await fg(pattern, {
      cwd,
      onlyFiles: true,
      // 默认会扫 node_modules 等噪声目录，忽略掉，避免结果爆炸
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    if (matches.length === 0) return `未找到匹配 ${pattern} 的文件`;
    return matches.join("\n"); // 一行一个路径，模型好读
  } catch (e) {
    return `错误：搜索失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// 3. 打包成"工具"（把描述和函数绑一起，方便注册）
export const globTool = { def: globDef, handler: globHandler };
