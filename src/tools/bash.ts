import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { tmpDir } from "../config/paths.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

// 输出上限:trace 分析里见过一次工具结果把上下文从 2k 撑到 10k tokens,
// bash 的输出(如 cat 大文件、find /)更容易爆炸,必须截断。
// 超过上限不是直接丢中段:完整输出落盘到状态目录的 tmp/,返回路径让模型 read_file 续读
const MAX_OUTPUT = 4000;
// 缺省 30s、上限 120s:防止交互式命令或死循环把整个 agent loop 挂死
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export const bashDef: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description:
      "在当前工作目录(或指定 cwd)执行一条 shell 命令,返回 stdout/stderr。" +
      "适用:运行测试/构建/类型检查、git 操作、执行脚本、启动服务等文件工具做不了的事。" +
      "不适用:查看文件内容(用 read_file)、按内容搜索(用 grep)、找文件(用 glob)。" +
      "不支持交互式命令(如 vim、git rebase -i、需要输入的脚本),超时会被强制终止;" +
      "不要在命令里写 cd … && 切目录——想在某子目录跑命令就传 cwd 参数。" +
      `输出超过 ${MAX_OUTPUT} 字符时完整输出会落盘到临时文件,返回里给出路径,用 read_file 续读。`,
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
        cwd: {
          type: "string",
          description:
            "命令执行的工作目录(相对当前目录或绝对路径),缺省当前工作目录。想在某子目录跑命令时传这个,不要写 cd … &&",
        },
      },
      required: ["command"],
      additionalProperties: false,
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
  // cwd 参数:模型不用再手写 cd … &&。缺省回退当前工作目录
  const cwd =
    typeof args?.cwd === "string" && args.cwd ? args.cwd : process.cwd();
  // cwd 校验:不存在时 Bun.spawn 会抛 ENOENT(posix_spawn 'sh'),报错文案误导。
  // 在这里显式校验,走"错误："前缀约定,而不是让异常逃出 handler(评审 P1-4)
  if (cwd !== process.cwd() && !existsSync(cwd)) return `错误：cwd 不存在: ${cwd}`;

  // Bun.spawn 的 sh -c 等价于 node:child_process exec,但原生 promise、
  // 不需要 promisify,且 proc.kill() 能可靠地掐死超时命令
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // timedOut 标志:kill 让 proc.exited 正常 resolve(143=SIGTERM)而不是抛异常,
  // 没有这个标志,超时会被误报成"命令失败,退出码 143"(评审 P1-5)
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const out = [stdout, stderr && `[stderr]\n${stderr}`]
      .filter(Boolean)
      .join("\n");

    // 大输出不直接丢中段:完整内容落盘到状态目录 tmp/(不碰用户项目),
    // 返回里给出路径,模型可用 read_file 续读 —— 参考 opencode 的"全文落盘+预览+指引"
    const withSpill = async (text: string, status: string) => {
      if (out.length <= MAX_OUTPUT) return `${status}${truncate(text)}`;
      const spillPath = join(tmpDir(), `bash-${Date.now()}.out`);
      await Bun.write(spillPath, out); // Bun.write 自动建父目录
      return `${status}${truncate(text)}\n[完整输出(共 ${out.length} 字符)已落盘: ${spillPath},可用 read_file 读取剩余部分]`;
    };

    if (timedOut) {
      return `错误：命令超时(${timeout}ms)被终止\n${truncate(out.trim() || "(无输出)")}`;
    }
    if (exitCode === 0) {
      return withSpill(out.trim() || "(命令成功,无输出)", "");
    }
    return withSpill(out.trim(), `错误：命令失败,退出码 ${exitCode}\n`);
  } catch (e: any) {
    clearTimeout(timer);
    proc.kill(); // 兜底,防止异常路径留下孤儿进程
    if (timedOut) return `错误：命令超时(${timeout}ms)被终止`;
    return `错误：命令执行异常 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// mutates:命令可能改任何东西(git/构建/删文件),不能与其它写并行(见 registry.ts)
export const bashTool = { def: bashDef, handler: bashHandler, mutates: true };
