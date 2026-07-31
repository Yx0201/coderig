import { homedir } from "node:os";
import { join } from "node:path";

// ===== 路径收敛 =====
//
// coderig 会被装成全局命令,在别人的项目目录里运行。
// 所有状态文件一律进 ~/.coderig/,不能写进 process.cwd()(=用户的仓库),
// 否则跑在别人项目里会往人家目录里拉 logs/ 垃圾。
//
// 保留环境变量覆盖:A/B 实验时仍能把 trace 指到项目内,不破坏现有工作流。
//
// 为什么是函数不是常量:常量会在模块首次 import 时冻结环境变量的值,
// Bun 的模块缓存让"先 import 再设 env"的覆盖静默失效(测试里踩过)。
// 惰性函数每次调用现读,env 在进程任何时刻设置都生效;运行期间 env 不会变,
// 所以同一进程内返回值天然稳定,不存在"读到一半路径变了"的问题。

export function coderigHome(): string {
  return process.env.CODERIG_HOME || join(homedir(), ".coderig");
}

export function configPath(): string {
  return join(coderigHome(), "config.json");
}

export function tracePath(): string {
  return process.env.TRACE_PATH || join(coderigHome(), "trace.jsonl");
}

export function historyDir(): string {
  return process.env.HISTORY_DIR || join(coderigHome(), "history");
}
