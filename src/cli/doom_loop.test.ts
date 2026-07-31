import { test, expect } from "bun:test";
import { isDoomLoop, DOOM_LOOP_THRESHOLD, type CallSig } from "./doom_loop.ts";

const call = (name: string, args: string): CallSig => ({ name, args });

test("序列不足阈值不算死循环", () => {
  expect(isDoomLoop([call("bash", "git status"), call("bash", "git status")])).toBe(false);
});

test("末尾连续 N 次同名同参 → 死循环", () => {
  const calls = [
    call("read_file", '{"path":"a.ts"}'),
    call("edit_file", '{"path":"a.ts","old":"x"}'),
    call("edit_file", '{"path":"a.ts","old":"x"}'),
    call("edit_file", '{"path":"a.ts","old":"x"}'),
  ];
  expect(isDoomLoop(calls)).toBe(true);
});

test("同名但参数不同 → 不算(分页读同一文件是合法行为)", () => {
  const calls = [
    call("read_file", '{"path":"a.ts","offset":1}'),
    call("read_file", '{"path":"a.ts","offset":201}'),
    call("read_file", '{"path":"a.ts","offset":401}'),
  ];
  expect(isDoomLoop(calls)).toBe(false);
});

test("同参但工具名不同 → 不算", () => {
  const calls = [
    call("read_file", '{"path":"a.ts"}'),
    call("write_file", '{"path":"a.ts"}'),
    call("read_file", '{"path":"a.ts"}'),
  ];
  expect(isDoomLoop(calls)).toBe(false);
});

test("中间曾有重复但末尾已恢复 → 不算(只看当前)", () => {
  const calls = [
    call("bash", "git status"),
    call("bash", "git status"),
    call("bash", "git status"),
    call("bash", "git diff"),
  ];
  expect(isDoomLoop(calls)).toBe(false);
});

test("阈值可配:threshold=5 时连续 4 次不算", () => {
  const calls = Array.from({ length: 4 }, () => call("bash", "ls"));
  expect(isDoomLoop(calls, 5)).toBe(false);
  expect(isDoomLoop([...calls, call("bash", "ls")], 5)).toBe(true);
});

test("默认阈值与 opencode 对齐为 3", () => {
  expect(DOOM_LOOP_THRESHOLD).toBe(3);
});
