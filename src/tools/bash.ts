import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDef, ToolHandler } from "../llm/types.ts";

const execAsync = promisify(exec);

// 输出上限:trace 分析里见过一次工具结果把上下文从 2k 撑到 10k tokens,
// bash 的输出(如 cat 大文件、find /)更容易爆炸,必须截断
const MAX_OUTPUT = 4000;
// 缺省 30s、上限 120s:防止交互式命令或死循环把整个 agent loop 挂死
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const bashDef: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description:
      "在当前工作目录执行一条 shell 命令,返回 stdout/stderr。" +
      "适合运行测试、构建、git 查询等文件工具做不了的事。" +
      "不支持交互式命令(如 vim、需要输入的脚本),超时会被强制终止。" +
      `输出超过 ${MAX_OUTPUT} 字符会被截断——查看文件内容请用 read_file,搜索请用 grep。`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 shell 命令",
        },
        timeout: {
          type: "number",
          description: `超时毫秒数,缺省 ${DEFAULT_TIMEOUT_MS},最大 ${MAX_TIMEOUT_MS}`,
        },
      },
      required: ["command"],
    },
  },
};

// 截断到 MAX_OUTPUT:保留头尾各一半,中间标注省略量(报错信息常在尾部,只留头会丢关键信息)
function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return (
    s.slice(0, half) +
    `\n…[输出过长,中间省略 ${s.length - MAX_OUTPUT} 字符]…\n` +
    s.slice(-half)
  );
}

export const bashHandler: ToolHandler = async (args) => {
  const command = args?.command;
  if (!command) return "错误：缺少 command 参数";

  const timeout = Math.min(
    typeof args?.timeout === "number" && args.timeout > 0
      ? args.timeout
      : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.cwd(),
      timeout,
      maxBuffer: 5 * 1024 * 1024, // exec 的硬上限,超过直接报错;截断展示交给 truncate
    });
    const out = [stdout, stderr && `[stderr]\n${stderr}`]
      .filter(Boolean)
      .join("\n");
    return truncate(out.trim() || "(命令成功,无输出)");
  } catch (e: any) {
    // exec 失败时 error 对象上仍挂着已产生的 stdout/stderr,回传给模型帮它定位原因
    const detail = [e?.stdout, e?.stderr].filter(Boolean).join("\n").trim();
    if (e?.killed)
      return `错误：命令超时(${timeout}ms)被终止\n${truncate(detail)}`;
    return `错误：命令失败,退出码 ${e?.code ?? "?"}\n${truncate(detail || String(e?.message ?? e))}`;
  }
};

export const bashTool = { def: bashDef, handler: bashHandler };
