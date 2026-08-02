import { test, expect } from "bun:test";
import { TuiStore } from "./store.ts";
import { TuiTerm } from "./tuiTerm.ts";
import { CANCEL } from "./term.ts";

function mk() {
  const store = new TuiStore();
  const term = new TuiTerm(store);
  return { store, term };
}

test("非交互流:reasoning/content 进 live;end 落定成 thinking+assistant 块", async () => {
  const { store, term } = mk();
  term.onReasoning("想");
  term.onContent("正文");
  const live = store.getLive();
  expect(live.reasoning).toBe("想");
  expect(live.content).toBe("正文");

  term.end(); // 本轮流完结 → live 取走,落定
  expect(store.getLive().reasoning).toBe("");
  const blocks = store.getBlocks();
  expect(blocks[0]!.kind).toBe("thinking");
  expect(blocks[1]!.kind).toBe("assistant");
  await new Promise((r) => setImmediate(r));
});

test("promptInput:回车返回 buffer,取消返回 CANCEL", async () => {
  const { store, term } = mk();
  const p = term.promptInput();
  store.resolveModal("你好");
  expect(await p).toBe("你好");

  const p2 = term.promptInput();
  store.cancelModal();
  expect(await p2).toBe(CANCEL);
});

test("confirm:是→true,否/取消→false", async () => {
  const { store, term } = mk();
  const p = term.confirm("批准?");
  store.resolveModal("yes");
  expect(await p).toBe(true);

  const p2 = term.confirm("批准?");
  store.resolveModal("no");
  expect(await p2).toBe(false);

  const p3 = term.confirm("批准?");
  store.cancelModal();
  expect(await p3).toBe(false);
});

test("select:返回值或 CANCEL", async () => {
  const { store, term } = mk();
  const p = term.select<"allow" | "deny">("选择", [
    { value: "allow", label: "允许" },
    { value: "deny", label: "拒绝" },
  ]);
  store.resolveModal("deny");
  expect(await p).toBe("deny");

  const p2 = term.select<"allow" | "deny">("选择", [
    { value: "allow", label: "允许" },
  ]);
  store.cancelModal();
  expect(await p2).toBe(CANCEL);
});

test("notify/error/showUser 都进静态回卷", async () => {
  const { store, term } = mk();
  term.notify("提示");
  term.error("错误");
  term.showUser("用户问");
  const kinds = store.getBlocks().map((b) => b.kind);
  expect(kinds.slice(0, 3)).toEqual(["notice", "notice", "user"]);
});

test("attachExit + shutdown 只卸载一次(chat.ts 的 cancel 分支和函数末尾都会调)", () => {
  const { store, term } = mk();
  let n = 0;
  term.attachExit(() => (n += 1));
  term.shutdown();
  term.shutdown();
  expect(n).toBe(1);
  expect(store.isActive()).toBe(false);
});

test("活动状态跟着流走:start→waiting,reasoning→thinking,content→answering,end→idle", () => {
  const { store, term } = mk();
  term.start();
  expect(store.getActivity().kind).toBe("waiting");
  term.onReasoning("想");
  expect(store.getActivity().kind).toBe("thinking");
  term.onContent("答");
  expect(store.getActivity().kind).toBe("answering");
  term.end();
  expect(store.getActivity().kind).toBe("idle");
});

test("工具参数进度进活动行,不再往回卷灌 notice", () => {
  const { store, term } = mk();
  term.onToolCallProgress("read_file", 0);
  term.onToolCallProgress("read_file", 120);
  const a = store.getActivity();
  expect(a.kind).toBe("tool_args");
  expect(a.label).toBe("read_file");
  expect(a.chars).toBe(120);
  expect(store.getBlocks()).toHaveLength(0); // 关键:回卷里没有一串"正在生成…"噪音
});

test("thinking 折叠行:header 不自带 🤔(图标由渲染层加,否则出现两个)", () => {
  const { store, term } = mk();
  term.start();
  term.onReasoning("很长的思考");
  term.end();
  const b = store.getBlocks()[0] as { kind: string; header: string; body: string };
  expect(b.kind).toBe("thinking");
  expect(b.header).not.toContain("🤔");
  expect(b.header).toContain("thinking");
  expect(b.header).toContain("5 字"); // 思考字数
  expect(b.body).toBe("很长的思考");
});