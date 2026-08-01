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

// 权限策略配置(allow/deny 规则)。与 config.json 分开:config.json 是 provider
// 配置(env > 文件 > 向导),settings.json 是政策(用户手工编辑或审批时写入),
// 两者都是明文但都不含密钥,权限文件仍收紧到 0600 保持一致
export function settingsPath(): string {
  return join(coderigHome(), "settings.json");
}

// 改动前快照目录:mutating 工具(write/edit)落原内容,给"改错了可回滚"留底。
// 按会话分目录,快照文件是 <sha(绝对路径)>.prev + <sha>.meta.json(映射原路径)
export function snapshotDir(): string {
  return join(coderigHome(), "snapshots");
}

// 临时目录:bash 大输出落盘、其它工具中间产物。写进状态目录,
// 不碰用户项目;Bun.write 自动建父目录
export function tmpDir(): string {
  return join(coderigHome(), "tmp");
}

// plan 模式的计划文件目录:规划模式下模型唯一允许写的地方。
// 放状态目录(不污染用户项目);用户可在 ~/.coderig/plans/ 查看已生成的计划
export function plansDir(): string {
  return join(coderigHome(), "plans");
}
