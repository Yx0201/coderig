import { test, expect, afterEach } from "bun:test";
import {
  buildSystemPrompt,
  runtimeReminder,
  resolveSystemPrompt,
} from "./system.ts";

const savedVersion = process.env.PROMPT_VERSION;

afterEach(() => {
  if (savedVersion === undefined) delete process.env.PROMPT_VERSION;
  else process.env.PROMPT_VERSION = savedVersion;
});

test("normal 模式:含执行流程,不含规划段", () => {
  const p = buildSystemPrompt("normal");
  expect(p).toContain("执行流程");
  expect(p).toContain("工具使用规则");
  expect(p).toContain("验证规则");
  expect(p).not.toContain("规划模式");
  expect(p).not.toContain("exit_plan_mode");
});

test("plan 模式:workflow 段二选一切到规划段", () => {
  const p = buildSystemPrompt("plan");
  expect(p).toContain("规划模式");
  expect(p).toContain("exit_plan_mode");
  expect(p).toContain("plans/");
  expect(p).not.toContain("执行流程");
});

test("静态层不随模式变(身份/规则/验证)", () => {
  const normal = buildSystemPrompt("normal");
  const plan = buildSystemPrompt("plan");
  // 把模式段去掉后,静态部分应一致(基线纯净)
  const stripWorkflow = (s: string) => s.split("\n\n").slice(0, 3).join("\n\n");
  expect(stripWorkflow(normal)).toBe(stripWorkflow(plan));
});

test("runtimeReminder:normal + 空 todo 返回空串(不注入)", () => {
  // 评审 P2-2:没有值得注入的信号就返回空串,避免每轮塞一条"模式: 正常"的废话
  expect(runtimeReminder("normal", [])).toBe("");
  // plan 模式即使空 todo 也要注入模式信号
  expect(runtimeReminder("plan", [])).toContain("[运行时状态]");
  expect(runtimeReminder("plan", [])).toContain("规划");
});

test("runtimeReminder:有 todo 时列出清单", () => {
  const r = runtimeReminder("plan", [
    { id: "1", content: "读代码", status: "in_progress" },
    { id: "2", content: "改代码", status: "pending" },
  ]);
  expect(r).toContain("任务清单");
  expect(r).toContain("读代码");
  expect(r).toContain("[>] 读代码"); // in_progress 标记
  expect(r).toContain("规划");
});

test("resolveSystemPrompt:PROMPT_VERSION=none 跑无提示词基线", () => {
  process.env.PROMPT_VERSION = "none";
  const r = resolveSystemPrompt();
  expect(r.version).toBe("none");
  expect(r.content).toBeNull();
});

test("resolveSystemPrompt:plan 模式的 workflow 段含绝对计划目录", () => {
  const r = resolveSystemPrompt("plan");
  expect(r.content).toContain("规划模式"); // workflow 段
  // 评审 P0-1:计划目录绝对路径必须注入指令面,否则模型不知道计划写哪
  expect(r.content).toContain("/plans/");
  // 运行时状态不在 system 里(评审 P2-2:作为消息尾部注入,见 client.ts)
  expect(r.content).not.toContain("[运行时状态]");
});
