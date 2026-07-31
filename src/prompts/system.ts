export const PROMPT_VERSION = "v4"; // 每次改提示词就升版本,trace 对比全靠它
// v2: 适配 bash 工具 —— 新增"改完代码必须验证"纪律(小模型不会自发跑 tsc,必须写明),
//     bash 与文件工具的分工,以及"不读大文件"规则(v1 实验中一次读日志把上下文撑大 5 倍)
// v3: 寒暄不探索 —— 换 DeepSeek 后模型过度主动:用户只发"你好"就把项目文件读一遍,
//     白烧近万 token。补上"什么时候不该用工具"的边界(v2 只有该怎么用的纪律)
// v4: 陌生项目适配 —— 装成全局命令后,模型面对的不是"熟悉的自己的项目",
//     而是任意用户的任意项目。注入项目类型探测结果,验证规则从硬编码 tsc 改为
//     "先判断项目类型再选验证方式"

import { existsSync } from "node:fs";

// 探测项目类型:给模型一个"这是什么项目"的初始认知,
// 避免它面对陌生项目时靠猜。只探测最常见的几种,不全遍历。
// 用 existsSync 而非 Bun.file().exists():后者是 async,而 resolveSystemPrompt
// 必须同步(它被 client.ts 在发请求前调用,不能改成 async 传染整条链)
function detectProjectType(): string {
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
  return found.length > 0 ? found.join("、") : "未识别的项目类型";
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

export function buildSystemPrompt(): string {
  const projectType = detectProjectType();
  return [
    "你是一个运行在终端里的编码助手,通过工具读写用户的项目文件,帮助用户完成编码任务。",
    `当前工作目录: ${process.cwd()}`,
    `今天日期: ${new Date().toISOString().slice(0, 10)}`,
    `项目类型: ${projectType}`,
    "工具使用规则:",
    "- 用户只是打招呼、闲聊或问与项目无关的问题时,直接简短回答,不要调用工具探索项目",
    "- 修改文件前必须先 read_file 确认内容",
    "- edit_file 的 oldString 必须在文件中唯一匹配",
    "- 找文件用 glob,找内容用 grep,不要靠猜路径",
    "- 读写文件、搜索一律用专用文件工具;bash 只用于运行命令(编译/测试/git 等)",
    "- 不要读取日志、构建产物等大文件的全部内容;回答\"在哪里\"类问题优先看代码和目录结构",
    "验证规则(重要):",
    `- ${verificationGuide(projectType)}`,
    "- 有报错就读懂报错、修复代码、重新检查,直到通过为止;不允许没验证就宣布完成",
    "- 用户如果反馈代码有问题但没说原因,先跑检查命令拿到报错信息,不要靠猜",
    "回答规则: 简洁中文,完成任务后直接总结结果,不要重复文件内容。",
  ].join("\n");
}

// 实验开关:环境变量 PROMPT_VERSION=none 跑基线(不注入系统提示词),
// 缺省或其它值用当前版本的提示词。client 注入、tracer 记录都从这一处取,保证一致。
export function resolveSystemPrompt(): {
  version: string;
  content: string | null;
} {
  const version = process.env.PROMPT_VERSION || PROMPT_VERSION;
  if (version === "none") return { version, content: null };
  return { version, content: buildSystemPrompt() };
}
