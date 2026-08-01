import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { isIgnoredPath } from "./ignore.ts";

// 结果上限:大仓库里 `**/*` 能匹配成千上万文件,直接把 context 撑爆(缺口护栏,
// 与 grep 的命中上限同理)。超出截断并提示缩小 pattern
const MAX_RESULTS = 200;

export const globDef: ToolDef = {
  type: "function",
  function: {
    name: "glob",
    description:
      "按文件名模式递归搜索文件路径。适用:找某个名字的文件在哪、统计某种文件。" +
      "不适用:按内容找代码(用 grep)。" +
      "** 是最重要的通配符:**/文件名 能在任意层级找到该文件。" +
      "例:'**/config.json' 在任意目录下找叫 config.json 的文件;'**/*.ts' 找所有 ts 文件;" +
      "'src/**/*.test.js' 在 src 下找所有测试文件。注意:不带 ** 的 pattern 如 'config.json'" +
      "只匹配当前目录、不会递归,几乎用不到。" +
      `结果超过 ${MAX_RESULTS} 条会截断——先想清楚文件名特征再搜,别用太宽的 pattern。`,
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
      additionalProperties: false,
    },
  },
};

export const globHandler: ToolHandler = async (args) => {
  const pattern = args?.pattern;
  if (!pattern) return "错误：缺少 pattern 参数";
  const cwd = args?.path || ".";
  try {
    // Bun.Glob 与 fast-glob 语义一致:**/*.ts 递归匹配任意层级,*.ts 只匹配顶层
    const matches = await Array.fromAsync(
      new Bun.Glob(pattern).scan({ cwd, onlyFiles: true }),
    );
    // 排除 node_modules 与 VCS 目录(共享忽略规则,见 ignore.ts),避免结果爆炸
    const filtered = matches.filter((f) => !isIgnoredPath(f));
    if (filtered.length === 0) return `未找到匹配 ${pattern} 的文件`;
    if (filtered.length > MAX_RESULTS) {
      return (
        filtered.slice(0, MAX_RESULTS).join("\n") +
        `\n...(结果过多,共 ${filtered.length} 条,仅显示前 ${MAX_RESULTS} 条,请缩小 pattern)`
      );
    }
    return filtered.join("\n"); // 一行一个路径，模型好读
  } catch (e) {
    return `错误：搜索失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// 3. 打包成"工具"（把描述和函数绑一起，方便注册）
export const globTool = { def: globDef, handler: globHandler };
