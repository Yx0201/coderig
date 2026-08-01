// ===== 权限策略持久化:settings.json =====
//
// 与 config.json(provider 配置)分开:这里是"政策"——用户手工编辑或审批时
// 写入的 allow/deny 工具规则。路径走 paths.ts 的 settingsPath()(状态收敛约定)。
//
// 语义:
//   - permissions.allow: 工具名列表,会话启动时种子进 sessionAllows,
//     命中即放行(仍受敏感路径/危险命令的 rememberable=false 约束,那两类不可持久放行)
//   - permissions.deny:  工具名列表,deny-wins(见 permissions.ts 的 denyTools 参数),
//     命中即硬禁,且从模型的工具可见列表里隐藏(listDefs 过滤)
//
// 注意:deny 是"两条路径实现同一策略"——既过 checkPermission(硬禁)又从
// listDefs 隐藏(不给模型)。改 deny 语义(如按参数 deny)时两处都要改,
// 否则会出现"模型还能看见但调用被拒"或相反的不一致。
//
// 读取失败(文件不存在/损坏)一律降级为空配置,不能因为策略文件坏了搞崩对话。

import { settingsPath } from "./paths.ts";
import { chmod } from "node:fs/promises";

export interface PermissionSettings {
  allow: string[]; // 会话启动即放行的工具名
  deny: string[]; // 硬禁止且隐藏的工具名
}

export interface Settings {
  permissions: PermissionSettings;
}

const DEFAULT_SETTINGS: Settings = { permissions: { allow: [], deny: [] } };

// 读配置:文件不存在返回默认;JSON 解析失败或结构不对也回默认(降级不崩)
// 核心只读工具:若被配置 deny 会直接死锁——sysprompt 要求"改文件前先 read_file"、
// read-before-write 门也要求先读,read_file 被禁则永远读不了、也永远写不了(评审 P2-8)
const CORE_READ_TOOLS = ["read_file", "glob", "grep", "list_dir"];

export async function loadSettings(): Promise<Settings> {
  try {
    const file = Bun.file(settingsPath());
    if (!(await file.exists())) return DEFAULT_SETTINGS;
    const raw = JSON.parse(await file.text()) as Partial<Settings>;
    const deny = Array.isArray(raw.permissions?.deny) ? raw.permissions.deny : [];
    const deniedRead = CORE_READ_TOOLS.filter((t) => deny.includes(t));
    if (deniedRead.length > 0) {
      console.warn(
        `[coderig] settings.json 的 permissions.deny 包含只读工具(${deniedRead.join(", ")}),` +
          `会导致 read-before-write 门死锁(无法先读再写)。建议移除。`,
      );
    }
    return {
      permissions: {
        allow: Array.isArray(raw.permissions?.allow) ? raw.permissions.allow : [],
        deny,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// 写配置:Bun.write 自动建父目录;明文无密钥,仍收紧 0600 与 config.json 保持一致
export async function saveSettings(s: Settings): Promise<void> {
  await Bun.write(settingsPath(), JSON.stringify(s, null, 2) + "\n");
  await chmod(settingsPath(), 0o600);
}

// 追加一条权限(先读后写,保持幂等——已存在则不重复)。
// 供审批 UI 的"总是允许/总是禁止"写入
export async function addPermission(
  dir: "allow" | "deny",
  tool: string,
): Promise<void> {
  const s = await loadSettings();
  const list = s.permissions[dir];
  if (!list.includes(tool)) {
    list.push(tool);
    await saveSettings(s);
  }
}
