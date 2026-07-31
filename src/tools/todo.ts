import type { ToolDef, ToolHandler } from "../llm/types.ts";
import type { TodoItem } from "./context.ts";

// ===== todo:任务规划工具 =====
//
// 全行业(Claude Code TodoWrite / Codex update_plan / opencode todowrite)都有的
// "规划即状态"工具:模型把复杂任务拆成可勾选清单,清单活在会话上下文里,
// 每轮都看得到,防重复编辑、防漏做。不碰文件系统,纯会话内状态。
//
// 语义:
//   - 调用即整体替换:每次都要带上完整 todos(含已完成的项)
//   - status 状态机:pending → in_progress → completed,同一时刻最多一个 in_progress
//   - "完成才标 completed"是模型纪律(写进 description),harness 不强制

export const todoDef: ToolDef = {
  type: "function",
  function: {
    name: "todo",
    description:
      "维护任务规划清单(会话内状态,不碰文件系统)。适用:收到复杂任务(预计 3 步以上)时,先调用它把任务拆成可勾选步骤,再逐项执行。" +
      "不适用:单步简单任务(不必规划,直接做)。" +
      "调用即整体替换现有清单——每次都要带上完整 todos 数组(含已完成的项)。" +
      "状态机:status 为 pending(待办)/ in_progress(进行中)/ completed(已完成);" +
      "同一时刻最多一个 in_progress;只有真正做完才标 completed,不要按意图提前标完成。",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "完整的任务清单(整体替换现有清单)。3 步以上的任务才值得规划;步骤要具体可执行,避免含糊",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "唯一标识,如 '1'、'2'",
              },
              content: {
                type: "string",
                description: "任务描述,具体可执行",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description:
                  "任务状态:pending=待办 / in_progress=进行中(同一时刻最多一个) / completed=已完成",
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
};

// 不涉外部 IO,不需要 ctx 之外的东西;校验结构后整体替换 ctx.todos 并返回格式化清单
export const todoHandler: ToolHandler = async (args, ctx) => {
  const todos = args?.todos;
  if (!Array.isArray(todos)) return "错误：缺少 todos 数组参数";

  // 逐项校验,不合规的剔除;全不合规给错误,不静默接受空清单
  const valid: TodoItem[] = todos.filter(
    (t): t is TodoItem =>
      !!t &&
      typeof t.id === "string" &&
      typeof t.content === "string" &&
      (t.status === "pending" || t.status === "in_progress" || t.status === "completed"),
  );
  if (valid.length === 0)
    return "错误：todos 数组为空或格式不正确(id/content/status 必填,status 需为 pending/in_progress/completed)";

  // 原地替换,保持 ctx.todos 引用不变(chat.ts 持有同一对象)
  ctx.todos.splice(0, ctx.todos.length, ...valid);
  return formatTodos(valid);
};

function statusMark(s: TodoItem["status"]): string {
  return s === "completed" ? "x" : s === "in_progress" ? ">" : " ";
}

function formatTodos(todos: TodoItem[]): string {
  const pending = todos.filter((t) => t.status === "pending").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `- [${statusMark(t.status)}] ${t.content}`);
  return (
    `任务清单(共 ${todos.length}:${pending} 待办 · ${inProgress} 进行中 · ${done} 完成):\n` +
    lines.join("\n")
  );
}

export const todoTool = { def: todoDef, handler: todoHandler };
