import { relative, isAbsolute } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

export const grepDef: ToolDef = {
  type: "function",
  function: {
    name: "grep",
    description:
      "按内容搜索文件，返回包含匹配文本的文件名和匹配行。用于查找某段代码/字符串定义在哪个文件、哪个位置。" +
      "支持字面量或正则匹配。默认递归搜索指定目录(忽略 node_modules 与 .git)。",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "要搜索的文本或正则表达式，如 'function foo' 或 '^export const'",
        },
        path: {
          type: "string",
          description: "搜索的根目录或单个文件路径，默认当前工作目录",
        },
        isRegex: {
          type: "boolean",
          description: "pattern 是否作为正则解释，默认 false(字面量匹配)",
        },
      },
      required: ["pattern"],
    },
  },
};

// 结果上限：避免命中过多刷爆 history
const MAX_FILES = 20;
const MAX_LINES_PER_FILE = 5;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const grepHandler: ToolHandler = async (args) => {
  const pattern = args?.pattern;
  if (!pattern) return "错误：缺少 pattern 参数";
  const root = args?.path || ".";
  const isRegex = !!args?.isRegex;

  let re: RegExp;
  try {
    re = new RegExp(isRegex ? pattern : escapeRegExp(pattern));
  } catch (e) {
    return `错误：无效的正则 ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    // 收集要搜的文件列表（单文件则只搜它；目录则递归）
    let files: string[] = [];
    let isFileMode = false;
    // 判断 root 是文件还是目录:Bun.file().exists() 对目录返回 false,
    // 所以 exists=true 一定是文件;exists=false 再试目录
    const file = Bun.file(root);
    if (await file.exists()) {
      files = [root];
      isFileMode = true;
    }

    if (!isFileMode) {
      // 递归扫所有文件,Bun.Glob 的 ** 匹配任意层级
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true }),
      );
      files = entries
        .map((e) => `${root}/${e}`)
        .filter((f) => !f.includes("node_modules") && !f.includes("/.git/"));
    }

    const out: string[] = [];
    let fileCount = 0;
    for (const f of files) {
      if (fileCount >= MAX_FILES) {
        out.push(`... (结果过多，已截断，仅显示前 ${MAX_FILES} 个文件)`);
        break;
      }
      try {
        const content = await Bun.file(f).text();
        const lines = content.split("\n");
        const matched: { n: number; line: string }[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]; // noUncheckedIndexedAccess: 下标访问返回 string | undefined
          if (line !== undefined && re.test(line)) {
            matched.push({ n: i + 1, line: line.trim().slice(0, 100) });
            if (matched.length >= MAX_LINES_PER_FILE) break;
          }
        }
        if (matched.length) {
          fileCount++;
          const disp = isAbsolute(f) ? relative(root, f) : f;
          out.push(`${disp}:`);
          for (const m of matched) out.push(`  ${m.n}: ${m.line}`);
        }
      } catch {
        // 二进制或无权限文件，跳过
      }
    }
    if (out.length === 0) return `未找到匹配 ${pattern} 的内容`;
    return out.join("\n");
  } catch (e) {
    return `错误：搜索失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const grepTool = { def: grepDef, handler: grepHandler };
