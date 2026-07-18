import type { ToolDef, ToolHandler } from "../llm/types.ts";

// 内部 Map：name → {def, handler}
const tools = new Map<string, { def: ToolDef; handler: ToolHandler }>();

// 注册一个工具
export function register(tool: { def: ToolDef; handler: ToolHandler }) {
  tools.set(tool.def.function.name, { def: tool.def, handler: tool.handler });
}

// 拿所有工具描述 → 给 sendMessages 的 tools 参数
export function listDefs(): ToolDef[] {
  return [...tools.values()].map((t) => t.def);
}

// 按 name 拿 handler → loop 执行时用
export function get(name: string) {
  return tools.get(name);
}
