import { test, expect } from "bun:test";
import { todoHandler } from "./todo.ts";
import { createSessionContext } from "./context.ts";

test("todo:整体替换 + 返回格式化清单 + ctx 状态更新", async () => {
  const ctx = createSessionContext({});
  const r = await todoHandler(
    {
      todos: [
        { id: "1", content: "读代码", status: "in_progress" },
        { id: "2", content: "改代码", status: "pending" },
      ],
    },
    ctx,
  );
  expect(r).toContain("任务清单");
  expect(r).toContain("读代码");
  expect(ctx.todos.length).toBe(2);
  expect(ctx.todos[0]!.status).toBe("in_progress");
});

test("todo:二次调用整体替换旧清单", async () => {
  const ctx = createSessionContext({});
  await todoHandler(
    { todos: [{ id: "1", content: "第一步", status: "pending" }] },
    ctx,
  );
  await todoHandler(
    {
      todos: [
        { id: "1", content: "第一步", status: "completed" },
        { id: "2", content: "第二步", status: "in_progress" },
      ],
    },
    ctx,
  );
  expect(ctx.todos.length).toBe(2);
  expect(ctx.todos[0]!.status).toBe("completed");
  expect(ctx.todos[1]!.status).toBe("in_progress");
});

test("todo:空数组/缺参 → 错误", async () => {
  const ctx = createSessionContext({});
  const r1 = await todoHandler({ todos: [] }, ctx);
  expect(r1.startsWith("错误")).toBe(true);
  const r2 = await todoHandler({}, ctx);
  expect(r2.startsWith("错误")).toBe(true);
});

test("todo:非法项被剔除,至少保留一个合法项才成功", async () => {
  const ctx = createSessionContext({});
  const r = await todoHandler(
    {
      todos: [
        { id: "1", content: "合法", status: "pending" },
        { id: "2", content: 123, status: "pending" }, // content 非字符串
        { id: "3", content: "非法状态", status: "done" }, // 状态非法
      ],
    },
    ctx,
  );
  expect(r.startsWith("错误")).toBe(false);
  expect(ctx.todos.length).toBe(1);
  expect(ctx.todos[0]!.content).toBe("合法");
});
