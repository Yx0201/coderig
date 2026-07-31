import { test, expect } from "bun:test";
import { createSessionContext } from "./context.ts";

test("默认:mode=normal,confirm 默认批准,snapshot/gate no-op", async () => {
  const ctx = createSessionContext({});
  expect(ctx.state.mode).toBe("normal");
  expect(await ctx.confirm("x")).toBe(true);
  await expect(ctx.snapshot("a.ts")).resolves.toBeUndefined();
  expect(() => ctx.gate({ kind: "conflict", path: "a.ts" })).not.toThrow();
});

test("state 是共享引用:浅拷贝后改 mode 仍能传回原 ctx", async () => {
  // 模拟 runTool 的 `{ ...ctx, gate: 重绑 }` 浅拷贝场景——
  // 原始值属性(mode 是 string)改不到拷贝上,所以必须放对象引用里
  const ctx = createSessionContext({});
  const copy = { ...ctx, gate: () => {} };
  copy.state.mode = "plan";
  expect(ctx.state.mode).toBe("plan"); // 共享引用,原对象也变
});
