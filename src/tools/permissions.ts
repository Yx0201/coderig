// ===== 权限门:工具执行前的风险分级与确认策略 =====
//
// 为什么需要:后端换成云端大模型后,模型真的能正确执行 rm -rf / git reset --hard,
// "模型想乱搞但能力不够"的隐性保护没了;harness 给工具的权限 = 用户本人的权限,
// 中间没有任何闸门,一个误解就造成真实破坏。这是 Claude Code 的 permission 机制,
// 也是以后做沙箱时的策略挂点(沙箱只是 deny 的另一种执行方式)。
//
// 三级决策:
// - auto:纯只读操作,直接放行不打扰(观测层也不记,记了全是噪音)
// - ask :有副作用或碰敏感目标,执行前问用户。
//         rememberable=true 的可选"本会话不再询问"(会话级 allowlist);
//         危险命令/敏感路径 rememberable=false,每次都问
// - deny:硬禁止,问都不问——覆写 .env/私钥这类不可逆且无正当场景的操作
//
// 已知边界(有意不覆盖):grep/glob 也能读到敏感文件内容(如 grep -r KEY .),
// 但那需要内容级审计而非路径级,留给以后的出站数据审计层;当前先挡住
// 最主要的直读直写路径。

export type PermissionAction = "auto" | "ask" | "deny";

export interface PermissionDecision {
  action: PermissionAction;
  reason: string; // 给用户看的理由(含命令/路径预览),也是 tracer 的 approval 事件载荷
  rememberable: boolean; // 是否允许"本会话不再询问"
}

// ---- bash 命令分级 ----

// 危险命令:即使会话级 allowlist 放行了 bash,也每次必问。
// 共同特征:不可逆(删/重置/强推)、提权(sudo)、或把未审阅的内容直接喂给 shell(管道执行)
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf]\b|--recursive|--force)/, // rm -rf / rm -r / rm -f
  /\bsudo\b/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[f]/,
  /\bgit\s+push\b[^|]*--force/,
  /\bmkfs\b/,
  /\bdd\b[^|]*\bof=\/dev\//,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\|\s*(sudo\s+)?(ba|z)?sh\b/, // curl … | sh 这类管道执行
  /\bchmod\s+-[a-zA-Z]*R/,
  /\bchown\s+-[a-zA-Z]*R/,
];

// 只读命令白名单:整条命令(含管道每一段)都命中才 auto 放行。
// 只覆盖"纯观察、无副作用"的命令;构建/测试(bun test 等)虽然常用但有副作用
// (写缓存/产物),归 normal——问一次后可会话放行,不放白名单
const READONLY_CMD =
  /^(ls|pwd|cat|head|tail|less|grep|rg|find|wc|which|file|stat|du|df|tree|echo|date|whoami|uname|sort|uniq|jq|awk|git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|blame)|bunx\s+tsc|tsc)\b/;

// 白名单命令的"逃逸口子":命令本身在只读名单里,但特定参数让它有副作用
const READONLY_ESCAPE = [
  /\bfind\b[^|]*\s-(delete|exec)\b/, // find -delete / -exec 能删能跑
  /\bgit\s+branch\s+-[dD]\b/, // git branch -d 是删除
  /\bawk\b[^|]*\bsystem\s*\(/, // awk 的 system() 能执行任意命令
  /\b(bunx\s+)?tsc\b(?![^|]*--noEmit)/, // tsc 不带 --noEmit 会输出编译产物(写文件)
];

export type BashLevel = "readonly" | "normal" | "dangerous";

export function classifyBash(cmd: string): BashLevel {
  if (DANGEROUS_PATTERNS.some((re) => re.test(cmd))) return "dangerous";
  // 复合命令/重定向/命令替换无法静态判定副作用,一律不当纯只读。
  // 注意 `>` 是写文件,`&&`/`;` 后段可以是任何东西——宁可多问,不可漏放
  if (/&&|\|\||[;`>]|\$\(/.test(cmd)) return "normal";
  // 管道:每一段都得是白名单只读命令,且不带逃逸参数
  const segments = cmd.split("|").map((s) => s.trim());
  const allReadonly = segments.every(
    (seg) =>
      READONLY_CMD.test(seg) && !READONLY_ESCAPE.some((re) => re.test(seg)),
  );
  return allReadonly ? "readonly" : "normal";
}

// ---- 敏感路径 ----

// 命中这些路径的文件:read 要逐次问(内容会发往云端 API),write/edit 直接硬禁。
// 覆盖:环境变量文件(密钥集中地)、私钥/证书、ssh/aws/gnupg 配置目录
const SENSITIVE_PATH =
  /(^|\/)\.env($|\.)|\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)$|(^|\/)\.(ssh|aws|gnupg)\//;

// 命令/路径预览截断:给用户看的理由一行内读完
const PREVIEW = 120;
const preview = (s: string) =>
  s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;

// ---- 主判定 ----

// sessionAllows:会话级 allowlist(工具名集合),用户在确认提示里选
// "本会话不再询问 X" 时加入。危险命令/敏感路径不走它(rememberable=false)
export function checkPermission(
  toolName: string,
  args: unknown,
  sessionAllows: ReadonlySet<string>,
): PermissionDecision {
  const a = args as Record<string, unknown> | null;
  const path = typeof a?.path === "string" ? (a.path as string) : "";

  // 1. 敏感路径优先于一切:直读逐次问,直写硬禁
  if (path && SENSITIVE_PATH.test(path)) {
    if (toolName === "read_file") {
      return {
        action: "ask",
        reason: `读取敏感文件 ${path}(内容会发往云端 API)`,
        rememberable: false,
      };
    }
    if (toolName === "write_file" || toolName === "edit_file") {
      return {
        action: "deny",
        reason: `覆写/修改敏感文件 ${path} 不可逆且无正当场景,已硬禁止`,
        rememberable: false,
      };
    }
  }

  // 2. bash 按命令分级
  if (toolName === "bash") {
    const cmd = typeof a?.command === "string" ? (a.command as string) : "";
    const level = classifyBash(cmd);
    if (level === "dangerous") {
      return {
        action: "ask",
        reason: `危险命令(不可会话放行): ${preview(cmd)}`,
        rememberable: false,
      };
    }
    if (level === "readonly") return { action: "auto", reason: "", rememberable: false };
    if (sessionAllows.has("bash"))
      return { action: "auto", reason: "", rememberable: false };
    return {
      action: "ask",
      reason: `执行命令: ${preview(cmd)}`,
      rememberable: true,
    };
  }

  // 3. 其它写工具:问一次,可会话放行
  if (toolName === "write_file" || toolName === "edit_file") {
    if (sessionAllows.has(toolName))
      return { action: "auto", reason: "", rememberable: false };
    return {
      action: "ask",
      reason: `${toolName === "write_file" ? "创建/覆写" : "修改"}文件 ${path}`,
      rememberable: true,
    };
  }

  // 4. 只读工具(read_file 非敏感路径、grep、glob、list_dir、search_history)
  return { action: "auto", reason: "", rememberable: false };
}
