import type { ToolDef, ToolHandler } from "../llm/types.ts";

// 一个注册项。mutates 标记"该工具会改变外部状态"(写文件、跑命令),
// chat.ts 据此决定能不能并行:只读工具并发跑没问题,
// 但 edit_file 是 read-modify-write,同一轮并行两次会互相覆盖(后写的赢,且两次都报成功)
export interface ToolEntry {
  def: ToolDef;
  handler: ToolHandler;
  mutates?: boolean;
}

// 内部 Map：name → ToolEntry
const tools = new Map<string, ToolEntry>();

// 注册一个工具
export function register(tool: ToolEntry) {
  tools.set(tool.def.function.name, {
    def: tool.def,
    handler: tool.handler,
    mutates: tool.mutates,
  });
}

// 拿所有工具描述 → 给 sendMessages 的 tools 参数。
// hidden:从模型可见列表里剔除的工具名(配置级 deny 的工具直接不给模型,
// 省得它费 token 调一个必被拒的工具 —— 参考 opencode 的 visibleTools)
export function listDefs(hidden?: ReadonlySet<string>): ToolDef[] {
  return [...tools.values()]
    .filter((t) => !hidden?.has(t.def.function.name))
    .map((t) => t.def);
}

// 按 name 拿 handler → loop 执行时用
export function get(name: string) {
  return tools.get(name);
}
