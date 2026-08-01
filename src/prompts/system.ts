export const PROMPT_VERSION = "v6"; // 每次改提示词就升版本,trace 对比全靠它
// v2: 适配 bash 工具 —— 新增"改完代码必须验证"纪律(小模型不会自发跑 tsc,必须写明),
//     bash 与文件工具的分工,以及"不读大文件"规则(v1 实验中一次读日志把上下文撑大 5 倍)
// v3: 寒暄不探索 —— 换 DeepSeek 后模型过度主动:用户只发"你好"就把项目文件读一遍,
//     白烧近万 token。补上"什么时候不该用工具"的边界(v2 只有该怎么用的纪律)
// v4: 陌生项目适配 —— 装成全局命令后,模型面对的不是"熟悉的自己的项目",
//     而是任意用户的任意项目。注入项目类型探测结果,验证规则从硬编码 tsc 改为
//     "先判断项目类型再选验证方式"
// v5: 工具系统 Phase0-3 —— 新增 todo 工具:复杂任务先拆解规划再执行;
//     强化 grep 纪律(搜索内容用 grep 工具,别用 bash 的 grep,trace 里 grep 从没被用过)
// v6: sysprompt 架构 A+B+C+D —— 拆成 baseIdentity/toolRules/verification/workflow 段;
//     新增 plan 模式(workflow 段二选一,enter/exit_plan_mode 驱动,参考 Gemini);
//     运行时状态([运行时状态] 模式+todo)每轮注入;压缩提示词升级为结构化快照(compact.ts)

import { existsSync } from "node:fs";
import { plansDir } from "../config/paths.ts";
import type { AgentMode, TodoItem } from "../tools/context.ts";

// 探测项目类型:给模型一个"这是什么项目"的初始认知,
// 避免它面对陌生项目时靠猜。只探测最常见的几种,不全遍历。
// 用 existsSync 而非 Bun.file().exists():后者是 async,而 resolveSystemPrompt
// 必须同步(它被 client.ts 在发请求前调用,不能改成 async 传染整条链)
// 模块级 memoize(评审 P2-6):baseIdentity 和 verification 各调一次,一次运行内
// 项目类型不会变。不能写成模块顶层常量——那会在 import 时冻结 cwd/env,
// 测试里覆盖不掉(见 CLAUDE.md 第 5 条)
let projectTypeCache: string | null = null;
function detectProjectType(): string {
  if (projectTypeCache) return projectTypeCache;
  const checks: [string, string][] = [
    ["package.json", "Node.js/TypeScript 项目"],
    ["tsconfig.json", "TypeScript 项目"],
    ["go.mod", "Go 项目"],
    ["Cargo.toml", "Rust 项目"],
    ["pyproject.toml", "Python 项目"],
    ["requirements.txt", "Python 项目"],
    ["Gemfile", "Ruby 项目"],
    ["composer.json", "PHP 项目"],
  ];
  const found: string[] = [];
  for (const [file, label] of checks) {
    if (existsSync(file)) {
      found.push(label);
    }
  }
  projectTypeCache = found.length > 0 ? found.join("、") : "未识别的项目类型";
  return projectTypeCache;
}

// 按项目类型给验证命令建议。v3 硬编码 npx tsc --noEmit,
// 跑在 Python/Go 项目里是错的指令
function verificationGuide(projectType: string): string {
  if (projectType.includes("TypeScript") || projectType.includes("Node.js")) {
    return "修改 .ts/.js 代码后,用 bash 运行 npx tsc --noEmit 检查类型";
  }
  if (projectType.includes("Go")) {
    return "修改 .go 代码后,用 bash 运行 go build ./... 检查编译";
  }
  if (projectType.includes("Rust")) {
    return "修改 .rs 代码后,用 bash 运行 cargo check 检查编译";
  }
  if (projectType.includes("Python")) {
    return "修改 .py 代码后,用 bash 运行 python -m py_compile <文件> 检查语法";
  }
  return "修改代码后,先判断项目类型再选验证方式(看构建文件/测试命令)";
}

// ── 静态身份层:角色 + 环境(纯静态,PROMPT_VERSION 的 A/B 基线) ──
export function baseIdentity(): string {
  const projectType = detectProjectType();
  return [
    "你是一个运行在终端里的编码助手,通过工具读写用户的项目文件,帮助用户完成编码任务。",
    `当前工作目录: ${process.cwd()}`,
    `今天日期: ${new Date().toISOString().slice(0, 10)}`,
    `项目类型: ${projectType}`,
  ].join("\n");
}

// ── 静态规则层:工具纪律(纯静态) ──
export function toolRules(): string {
  return [
    "工具使用规则:",
    "- 用户只是打招呼、闲聊或问与项目无关的问题时,直接简短回答,不要调用工具探索项目",
    "- 修改文件前必须先 read_file 确认内容",
    "- edit_file 的 oldString 必须在文件中唯一匹配",
    "- 找文件用 glob,找内容用 grep 工具(不要用 bash 的 grep),不要靠猜路径",
    "- 读写文件、搜索一律用专用文件工具;bash 只用于运行命令(编译/测试/git 等)",
    "- 复杂任务(预计 3 步以上)先调用 todo 工具拆解成可勾选清单,逐项执行并更新状态,完成一项标一项",
    "- 不要读取日志、构建产物等大文件的全部内容;回答\"在哪里\"类问题优先看代码和目录结构",
  ].join("\n");
}

// ── 静态规则层:验证纪律(按项目类型,仍属静态) ──
export function verification(): string {
  const projectType = detectProjectType();
  return [
    "验证规则(重要):",
    `- ${verificationGuide(projectType)}`,
    "- 有报错就读懂报错、修复代码、重新检查,直到通过为止;不允许没验证就宣布完成",
    "- 用户如果反馈代码有问题但没说原因,先跑检查命令拿到报错信息,不要靠猜",
  ].join("\n");
}

// ── 模式段:workflow 二选一(参考 Gemini primary/planning Workflow) ──
const NORMAL_WORKFLOW = [
  "执行流程: 按\"调查 → 实施 → 验证 → 简洁总结\"推进。",
  "改动涉及 3 个以上文件、或有不可逆风险(删文件/改配置/动数据)时,先调用 enter_plan_mode 只读调研并提交计划审批再动手;单文件小改直接做。",
  "回答规则: 简洁中文,完成任务后直接总结结果,不要重复文件内容。",
].join("\n");

// plan 模式段:写入绝对路径 plansDir(),否则模型不知道计划该写哪(评审 P0-1)
function planWorkflow(): string {
  return [
    "当前处于规划模式(只读):",
    `- 只能读写 ${plansDir()}/ 目录下的计划文件,禁止修改项目文件(plan 模式下对其它路径的写会被拒绝)`,
    "- 先调查清楚:用 grep/glob/read_file 和只读 bash 了解现状",
    `- 把实施计划用 write_file 写到 ${plansDir()}/ 下(包含:目标、步骤、涉及文件、验证方式)`,
    "- 写完后调用 exit_plan_mode(plan_path=...) 提交审批",
    "- 未批准前不要动手改代码;批准后按计划实施",
  ].join("\n");
}

export function workflow(mode: AgentMode): string {
  return mode === "plan" ? planWorkflow() : NORMAL_WORKFLOW;
}

// 组装:静态身份 + 规则 + 验证 + 模式段。filter(Boolean) 便于将来按条件注入;
// 段间空行分隔,既利于模型阅读,也让"A/B 基线纯净"可验证(切掉模式段后静态部分一致)
export function buildSystemPrompt(mode: AgentMode = "normal"): string {
  return [baseIdentity(), toolRules(), verification(), workflow(mode)]
    .filter(Boolean)
    .join("\n\n");
}

// ── 运行时状态层:每轮注入,与静态正文区分(标 [运行时状态]) ──
// 模式 + todo 清单摘要。normal + 空 todo 时返回空串:没有值得注入的信号,
// 就别往请求里塞一条"模式: 正常"的废话(评审 P2-2)
export function runtimeReminder(mode: AgentMode, todos: TodoItem[]): string {
  if (mode === "normal" && todos.length === 0) return "";
  const lines = [
    "[运行时状态]",
    `模式: ${mode === "plan" ? "规划(只读+计划文件)" : "正常"}`,
  ];
  if (todos.length > 0) {
    lines.push("任务清单:");
    for (const t of todos) {
      const mark =
        t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " ";
      lines.push(`- [${mark}] ${t.content}`);
    }
  }
  return lines.join("\n");
}

// 实验开关:环境变量 PROMPT_VERSION=none 跑基线(不注入系统提示词),
// 缺省或其它值用当前版本的提示词。client 注入、tracer 记录都从这一处取,保证一致。
// mode 决定 workflow 段(plan/normal);运行时状态不由这里拼(评审 P2-2,
// 作为消息尾部注入,见 client.ts)
export function resolveSystemPrompt(mode: AgentMode = "normal"): {
  version: string;
  content: string | null;
} {
  const version = process.env.PROMPT_VERSION || PROMPT_VERSION;
  if (version === "none") return { version, content: null };
  return { version, content: buildSystemPrompt(mode) };
}
