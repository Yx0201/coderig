import { test, expect } from "bun:test";
import { TuiStore } from "./store.ts";

const microTask = () => new Promise((r) => queueMicrotask(r));

test("append 触发一次通知(一帧合并):多次 append 只 notify 一次", async () => {
  const s = new TuiStore();
  let notifies = 0;
  s.subscribe(() => notifies++);
  const v0 = s.getSnapshot();
  s.appendContent("a"); // 同一宏任务内 3 次 append
  s.appendContent("b");
  s.appendContent("c");
  expect(notifies).toBe(0); // microtask 未 flush 前不通知
  await microTask();
  expect(notifies).toBe(1); // 合并成一次
  expect(s.getSnapshot()).toBe(v0 + 1);
});

test("不同宏任务的 append 各通知一次", async () => {
  const s = new TuiStore();
  let notifies = 0;
  s.subscribe(() => notifies++);
  s.appendContent("a");
  await microTask();
  s.appendContent("b");
  await microTask();
  expect(notifies).toBe(2);
});

test("unsubscribe 后不再通知", async () => {
  const s = new TuiStore();
  let n = 0;
  const off = s.subscribe(() => n++);
  off();
  s.pushUser("hi");
  await microTask();
  expect(n).toBe(0);
});

test("live 区累积 + takeLive 取走并清空", async () => {
  const s = new TuiStore();
  s.appendReasoning("思考中");
  s.appendContent("正文");
  expect(s.getSnapshot()).toBe(0); // microtask 未flush,但数据已进
  const live = s.takeLive();
  expect(live.reasoning).toBe("思考中");
  expect(live.content).toBe("正文");
  expect(s.takeLive().content).toBe(""); // 已清空
  await microTask();
});

test("静态块按序入列 + 版本推进", async () => {
  const s = new TuiStore();
  s.pushUser("hi");
  s.pushAssistant("ans");
  s.pushThinking("思考", "body", true);
  s.pushTool("read_file", "读取 a.ts · 共 3 行", true, 12);
  s.pushNotice("notice");
  await microTask();
  const blocks = s.getBlocks();
  expect(blocks.map((b) => b.kind)).toEqual([
    "user",
    "assistant",
    "thinking",
    "tool",
    "notice",
  ]);
});

test("模态:openModal 返回 Promise,resolveModal 用确定值 resolve 并清模态", async () => {
  const s = new TuiStore();
  const p = s.openModal("select", {
    title: "选择",
    options: [{ value: "allow", label: "允许" }],
  });
  expect(s.hasModal()).toBe(true);
  s.resolveModal("allow");
  expect(s.hasModal()).toBe(false);
  expect(await p).toBe("allow");
});

test("模态:cancelModal 把 Promise resolve 成 undefined(取消语义)", async () => {
  const s = new TuiStore();
  const p = s.openModal("text", { title: "输入" });
  s.cancelModal();
  expect(await p).toBe(undefined);
  expect(s.hasModal()).toBe(false);
});
test("notice:剥掉为线性输出准备的首尾换行,空内容整条丢弃", async () => {
  const s = new TuiStore();
  s.pushNotice("\n⛔ 已阻止: x\n");
  s.pushNotice(""); // chat.ts 用 notify("") 给线性模式换行,TUI 不需要
  s.pushNotice("\n\n");
  await microTask();
  const blocks = s.getBlocks();
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toEqual({ kind: "notice", text: "⛔ 已阻止: x" });
});

test("deactivate 后 notice 直写 stdout(Ink 已卸载,塞进 store 会静默丢掉)", async () => {
  const s = new TuiStore();
  s.deactivate();
  const orig = process.stdout.write.bind(process.stdout);
  const seen: string[] = [];
  (process.stdout as any).write = (c: any) => (seen.push(String(c)), true);
  try {
    s.pushNotice("✓ 完成");
  } finally {
    (process.stdout as any).write = orig;
  }
  expect(seen.join("")).toBe("✓ 完成\n");
  expect(s.getBlocks()).toHaveLength(0);
  expect(s.isActive()).toBe(false);
});

test("setActivity:同 kind+label 重复设置不重置计时(否则耗时永远显示 0.0s)", async () => {
  const s = new TuiStore();
  s.setActivity("tool_args", { label: "read_file", chars: 1 });
  const t0 = s.getActivity().startedAt;
  s.setActivity("tool_args", { label: "read_file", chars: 99 });
  expect(s.getActivity().startedAt).toBe(t0);
  expect(s.getActivity().chars).toBe(99);
  s.setActivity("thinking"); // 换了活动 → 重新计时
  expect(s.getActivity().startedAt).toBeGreaterThanOrEqual(t0);
  expect(s.getActivity().label).toBeUndefined();
  await microTask();
});
