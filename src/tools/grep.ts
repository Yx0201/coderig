import { relative, isAbsolute } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { isIgnoredPath } from "./ignore.ts";

export const grepDef: ToolDef = {
  type: "function",
  function: {
    name: "grep",
    description:
      "按内容搜索文件,返回命中文件名、行号和上下文行。适用:找某段代码/字符串定义在哪个文件哪个位置、" +
      "查所有调用点。不适用:按文件名找路径(用 glob)、查看文件内容(用 read_file)。" +
      "支持字面量或正则(isRegex=true)匹配,默认递归搜索指定目录(忽略 node_modules 与 .git 等 VCS 目录)。" +
      "contextLines 控制命中行前后各带几行上下文,定位定义时建议带上(如 2)减少二次 read_file。" +
      "命中过多会截断(每文件最多 5 处、最多 20 个文件)——先想清楚要搜的词,别搜太宽;搜字面量含正则特殊字符时用 isRegex=false(默认)。",
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
        contextLines: {
          type: "number",
          description: "每处命中前后各带几行上下文(0-5)，默认 0",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

// 结果上限：避免命中过多刷爆 history
const MAX_FILES = 20;
const MAX_LINES_PER_FILE = 5;
const MAX_CONTEXT = 5; // contextLines 参数上限,防止模型要求把整个文件带进来
// 单行显示上限:minified/长行截断,带省略标记(参考 Claude Code 的 500 字符单行截断,我们更保守)
const LINE_SHOW = 200;
// 搜索超时:大目录(如整个 home)扫起来能到分钟级,30s 就停(参考 Gemini 的 30s)
const SEARCH_TIMEOUT_MS = 30_000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 单行截断:过长行(如 minified 代码)不整行塞进 context
function formatLine(line: string): string {
  const t = line.trim();
  return t.length > LINE_SHOW ? `${t.slice(0, LINE_SHOW)}…` : t;
}

export const grepHandler: ToolHandler = async (args) => {
  const pattern = args?.pattern;
  if (!pattern) return "错误：缺少 pattern 参数";
  const root = args?.path || ".";
  const isRegex = !!args?.isRegex;
  // contextLines:前后各带几行上下文,夹到 [0, MAX_CONTEXT]。
  // 非数字(如 "abc")先转 Number 再判有限,否则 Math.floor 出 NaN,
  // start/end 全变 NaN 会让命中行整个消失(评审 P1-3)
  const rawContext = Number(args?.contextLines);
  const context = Number.isFinite(rawContext)
    ? Math.min(MAX_CONTEXT, Math.max(0, Math.floor(rawContext)))
    : 0;

  let re: RegExp;
  try {
    re = new RegExp(isRegex ? pattern : escapeRegExp(pattern));
  } catch (e) {
    return `错误：无效的正则 ${e instanceof Error ? e.message : String(e)}`;
  }

  // 协作式超时(评审 P1-2):不用 Promise.race(那只是让外层先返回,search 还在后台空转),
  // 在文件循环里查 deadline,超时当场停。超时与内部异常从此分开报,不再糊成一个文案
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const TIMEOUT_NOTE = `... (搜索超时(${SEARCH_TIMEOUT_MS / 1000}s),结果不完整,请缩小 path 范围)`;

  const search = async (): Promise<string[]> => {
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
      // 递归扫所有文件,Bun.Glob 的 ** 匹配任意层级。
      // dot:true 让 .gitignore/.github 这类隐藏文件也进候选(评审 P0-3 实测暴露:
      // 不带 dot 点文件根本不进文件列表,连被忽略的机会都没有);
      // 真正的忽略(node_modules/VCS)由 isIgnoredPath 在下面过滤
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true }),
      );
      files = entries.map((e) => `${root}/${e}`).filter((f) => !isIgnoredPath(f));
    }
    // 文件收集本身也可能超时(超大目录),先查一次 deadline
    if (Date.now() > deadline) return [TIMEOUT_NOTE];

    const out: string[] = [];
    let fileCount = 0;
    for (const f of files) {
      if (Date.now() > deadline) {
        out.push(TIMEOUT_NOTE);
        break;
      }
      if (fileCount >= MAX_FILES) {
        out.push(`... (结果过多，已截断，仅显示前 ${MAX_FILES} 个文件)`);
        break;
      }
      try {
        const content = await Bun.file(f).text();
        const lines = content.split("\n");
        // 命中行下标(0-based)。先扫出本文件的命中,再决定是否输出(含 context 行)
        const matchedIdx: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]; // noUncheckedIndexedAccess: 下标访问返回 string | undefined
          if (line !== undefined && re.test(line)) {
            matchedIdx.push(i);
            if (matchedIdx.length >= MAX_LINES_PER_FILE) break;
          }
        }
        if (matchedIdx.length === 0) continue;
        fileCount++;
        const disp = isAbsolute(f) ? relative(root, f) : f;
        out.push(`${disp}:`);
        for (const mi of matchedIdx) {
          // 命中行 + contextLines 上下文行;命中行用「  n:」,上下文行用「· n:」区分
          const start = Math.max(0, mi - context);
          const end = Math.min(lines.length - 1, mi + context);
          for (let l = start; l <= end; l++) {
            const isHit = l === mi;
            out.push(`${isHit ? "  " : "· "}${l + 1}: ${formatLine(lines[l] ?? "")}`);
          }
        }
      } catch {
        // 二进制或无权限文件，跳过
      }
    }
    return out;
  };

  try {
    const out = await search();
    if (out.length === 0) return `未找到匹配 ${pattern} 的内容`;
    return out.join("\n");
  } catch (e) {
    return `错误：搜索失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const grepTool = { def: grepDef, handler: grepHandler };
