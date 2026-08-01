import { resolve, sep } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { plansDir } from "../config/paths.ts";
import { classifyBash } from "./permissions.ts";

// plan 模式写守卫(评审 P0-1):写工具只能写 plans/ 目录;非只读 bash 一并拦掉。
// 抽出来供 chat.ts 与测试共用。报错里带 plansDir() 绝对路径,模型才知道计划写哪。
// 返回 null 表示放行,返回字符串表示拒绝原因("错误：" 前缀)
export function planGuardViolation(toolName: string, args: any): string | null {
  if (toolName === "write_file" || toolName === "edit_file") {
    const target = typeof args?.path === "string" ? args.path : "";
    const inPlans =
      target !== "" && resolve(target).startsWith(resolve(plansDir()) + sep);
    if (!inPlans)
      return (
        `错误：规划模式只读,只能写 ${plansDir()}/ 下的计划文件(收到路径 ${target || "(空)"})。` +
        `把计划写到 ${plansDir()}/ 下,或先 exit_plan_mode 再改代码。`
      );
  }
  if (toolName === "bash") {
    const cmd = typeof args?.command === "string" ? args.command : "";
    const level = classifyBash(cmd);
    // 只拦会改状态的(normal/dangerous);sensitive(cat .env)是只读,plan 模式放行,
    // 但会走权限门的敏感分支逐次问(见 permissions.ts)
    if (level === "normal" || level === "dangerous")
      return "错误：规划模式只读,禁止执行会修改状态的命令。只读命令(如 git status/ls/grep)可以执行。";
  }
  return null;
}

// ===== plan 模式:enter / exit_plan_mode =====
//
// 参考 Gemini 的 enter_plan_mode/exit_plan_mode:规划是一种"只读模式",
// 模型先调查、把实施计划写到 plans/ 目录,再提交审批;批准后进入正常模式实施。
// 本实现对学习型 harness 的裁剪:
//   - 模式状态放 ctx.state.mode(共享对象,见 context.ts D1),由 sysprompt 的
//     workflow 段二选一驱动,写入被 plan 写守卫拦(见 chat.ts)
//   - exit 的审批 UI 走 ctx.confirm 钩子(chat.ts 注入 p.confirm),handler 不碰 UI

export const enterPlanModeDef: ToolDef = {
  type: "function",
  function: {
    name: "enter_plan_mode",
    description:
      "进入规划模式(只读)。适用:需要改多个文件/有风险的实现任务,先规划再动手。" +
      "进入后只读:只能读写 plans/ 目录下的计划文件,禁止修改项目文件。" +
      "调查清楚后把实施计划用 write_file 写到 plans/,再调用 exit_plan_mode 提交审批。" +
      "不适用:简单单步任务(直接做,不必进规划)。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "可选:本次要规划的任务描述(便于记录)",
        },
      },
      additionalProperties: false,
    },
  },
};

export const enterPlanModeHandler: ToolHandler = async (args, ctx) => {
  ctx.state.mode = "plan";
  const task =
    typeof args?.task === "string" && args.task ? `(任务: ${args.task})` : "";
  return (
    `已进入规划模式 ${task}。当前只读:只能读写 ${plansDir()}/ 目录下的计划文件,不能修改项目文件。` +
    `请先调查清楚(grep/glob/read_file/只读 bash),再把实施计划用 write_file 写到 ${plansDir()}/ 下,` +
    `最后调用 exit_plan_mode(plan_path=...) 提交审批。未批准前不要动手改代码。`
  );
};

export const exitPlanModeDef: ToolDef = {
  type: "function",
  function: {
    name: "exit_plan_mode",
    description:
      "退出规划模式并提交计划审批。调用前必须已把计划写入 plans/ 目录(传 plan_path),或直接带 plan 正文。" +
      "harness 会把计划展示给用户:批准后你进入正常模式并按计划实施;未批准则按反馈修改计划后重新提交。",
    parameters: {
      type: "object",
      properties: {
        plan_path: {
          type: "string",
          description: "计划文件路径(应写在 plans/ 目录下)",
        },
        plan: {
          type: "string",
          description: "计划正文(不传 plan_path 时用这个)",
        },
      },
      additionalProperties: false,
    },
  },
};

export const exitPlanModeHandler: ToolHandler = async (args, ctx) => {
  const planPath = typeof args?.plan_path === "string" ? args.plan_path : "";
  const inline = typeof args?.plan === "string" ? args.plan : "";
  let content = inline;
  if (planPath) {
    try {
      content = await Bun.file(planPath).text();
    } catch {
      return `错误：读取计划文件失败 ${planPath},请确认路径正确(计划应写在 plans/ 目录下)`;
    }
  }
  if (!content.trim())
    return "错误：exit_plan_mode 需要 plan_path(计划文件路径)或 plan(计划正文)";

  // 展示给用户审批;批准才切回正常模式,拒绝则保持规划模式让模型修改
  const ok = await ctx.confirm(`批准以下计划并开始实施?\n\n${content.slice(0, 2000)}`);
  if (ok) {
    ctx.state.mode = "normal";
    return `计划已批准。你现在处于正常模式,请严格按计划实施。\n\n${content.slice(0, 2000)}`;
  }
  return "计划未批准。请根据用户反馈修改计划后,重新调用 exit_plan_mode 提交。";
};

// 控制类工具,不改文件系统 → 无 mutates(并行安全)
export const enterPlanModeTool = { def: enterPlanModeDef, handler: enterPlanModeHandler };
export const exitPlanModeTool = { def: exitPlanModeDef, handler: exitPlanModeHandler };
