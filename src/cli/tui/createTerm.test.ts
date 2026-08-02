import { test, expect } from "bun:test";
import { createTerm } from "./term.ts";
import { LinearTerm } from "./linearTerm.ts";

// createTerm 的 TTY 门:非 TTY / NO_TUI → 一定回退线性实现(绝不起 Ink 侧)。
// (TUI 分支需要真 TTY,由 app.test 的 fake stdin + createTerm 的运行期验证覆盖)

test("NO_TUI=1 强制回退 LinearTerm", () => {
  process.env.NO_TUI = "1";
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  const term = createTerm();
  expect(term).toBeInstanceOf(LinearTerm);
  delete process.env.NO_TUI;
});

test("非 TTY(stdin 非 real)回退 LinearTerm", () => {
  process.env.NO_TUI = "0";
  (process.stdin as any).isTTY = false;
  (process.stdout as any).isTTY = false;
  const term = createTerm();
  expect(term).toBeInstanceOf(LinearTerm);
});