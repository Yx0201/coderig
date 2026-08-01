import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enterPlanModeHandler, exitPlanModeHandler, planGuardViolation } from "./plan_mode.ts";
import { createSessionContext } from "./context.ts";

test("enter_plan_mode:切到 plan 模式并返回只读规则", async () => {
  const ctx = createSessionContext({});
  const r = await enterPlanModeHandler({ task: "加个功能" }, ctx);
  expect(ctx.state.mode).toBe("plan");
  expect(r).toContain("规划模式");
  expect(r).toContain("exit_plan_mode");
});

test("exit_plan_mode:批准 → 切回 normal,返回批准文案", async () => {
  const ctx = createSessionContext({ confirm: async () => true });
  const r = await exitPlanModeHandler(
    { plan: "步骤1:读代码\n步骤2:改代码\n步骤3:验证" },
    ctx,
  );
  expect(ctx.state.mode).toBe("normal");
  expect(r).toContain("批准");
  expect(r).toContain("步骤1");
});

test("exit_plan_mode:拒绝 → 保持 plan,返回未批准", async () => {
  const ctx = createSessionContext({ confirm: async () => false });
  await enterPlanModeHandler({}, ctx);
  expect(ctx.state.mode).toBe("plan");
  const r = await exitPlanModeHandler({ plan: "方案A" }, ctx);
  expect(ctx.state.mode).toBe("plan"); // 拒绝后仍是规划模式
  expect(r).toContain("未批准");
});

test("exit_plan_mode:缺计划参数 → 错误", async () => {
  const ctx = createSessionContext({});
  const r = await exitPlanModeHandler({}, ctx);
  expect(r.startsWith("错误")).toBe(true);
});

test("exit_plan_mode:plan_path 读文件内容并展示给用户", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coderig-test-"));
  try {
    const file = join(dir, "plan.md");
    await Bun.write(file, "这是计划正文");
    let shown = "";
    const ctx = createSessionContext({
      confirm: async (msg) => {
        shown = msg;
        return true;
      },
    });
    const r = await exitPlanModeHandler({ plan_path: file }, ctx);
    expect(shown).toContain("这是计划正文"); // 计划被展示给用户
    expect(ctx.state.mode).toBe("normal");
    expect(r).toContain("批准");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit_plan_mode:plan_path 文件不存在 → 错误", async () => {
  const ctx = createSessionContext({});
  const r = await exitPlanModeHandler({ plan_path: "/no/such/plan.md" }, ctx);
  expect(r.startsWith("错误")).toBe(true);
});

test("planGuardViolation:写计划目录放行,写项目文件/相对 plans 拒绝(评审 P0-1)", () => {
  const home = mkdtempSync(join(tmpdir(), "coderig-test-"));
  const saved = process.env.CODERIG_HOME;
  process.env.CODERIG_HOME = home;
  try {
    const plans = join(home, "plans");
    // 计划目录内的绝对路径 → 放行
    expect(planGuardViolation("write_file", { path: join(plans, "plan.md") })).toBeNull();
    // 项目文件 → 拒绝
    expect(planGuardViolation("write_file", { path: "src/a.ts" })).toContain("规划模式只读");
    // 相对 "plans/" 解析到 cwd/plans(用户项目),不是状态目录 → 拒绝
    expect(planGuardViolation("write_file", { path: "plans/plan.md" })).toContain("规划模式只读");
    // 空 path → 拒绝
    expect(planGuardViolation("write_file", { path: "" })).toContain("规划模式只读");
    // 其它工具不受影响
    expect(planGuardViolation("read_file", { path: "src/a.ts" })).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.CODERIG_HOME;
    else process.env.CODERIG_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("planGuardViolation:只读 bash 放行,会改状态的 bash 拒绝", () => {
  expect(planGuardViolation("bash", { command: "ls" })).toBeNull();
  expect(planGuardViolation("bash", { command: "git status" })).toBeNull();
  expect(planGuardViolation("bash", { command: "echo x > src/a.ts" })).toContain("规划模式只读");
  expect(planGuardViolation("bash", { command: "bun test" })).toContain("规划模式只读");
});
