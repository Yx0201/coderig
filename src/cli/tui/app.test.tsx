import { test, expect, afterEach } from "bun:test";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import { TuiStore } from "./store.ts";

// 捕获 stdout.write。render 用 debug 模式:每帧渲染成独立输出(不做光标替换),
// 这样"随时间 add 进 <Static>"的块也能被逐帧看到——不需要真 TTY。
const origWrite = process.stdout.write.bind(process.stdout);
let captured: string[] = [];
function capture() {
  captured = [];
  (process.stdout as any).write = (chunk: any) => {
    captured.push(String(chunk));
    return true;
  };
}
afterEach(() => {
  (process.stdout as any).write = origWrite;
});
const tick = () => new Promise((r) => setTimeout(r, 15));

// App 用了 useInput(需要 raw mode);测试非交互渲染给它一个假 stdin + 声明
// "raw mode 支持",既不触碰真实 process.stdin 也不抛"Raw mode is not supported"
function fakeStdin(): any {
  const s: any = {
    isTTY: true,
    setEncoding: () => {},
    setRawMode: () => s,
    ref: () => {},
    unref: () => {},
    pause: () => {},
    resume: () => {},
    on: () => s,
    once: () => s,
    off: () => s,
    removeListener: () => s,
    addListener: () => s,
    destroy: () => {},
  };
  return s;
}
function renderApp(store: TuiStore) {
  return render(<App store={store} />, {
    debug: true,
    stdin: fakeStdin(),
    isRawModeSupported: true,
  } as any);
}

test("流式 live 增量 + 静态落定进回卷 + 固定底部条", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);

  store.setStatus("m", { prompt: 10, completion: 5 });
  store.pushUser("写个函数"); // 历史块
  await tick();
  store.appendReasoning("先想签名"); // live 增量
  await tick();
  store.appendReasoning("再写类型");
  await tick();
  store.appendContent("```ts\nfunction"); // live 正文增量
  await tick();
  store.appendContent(" add(){}\n```");
  await tick();
  // 本轮流完结 → 落定:live 清空,推入带可折叠思考 + 完整 markdown 的历史块
  store.takeLive();
  store.pushThinking("思考 (1.5s)", "先想签名再写类型", true);
  store.pushAssistant("**完成**:给出 `add` 函数");
  await tick();
  await app.unmount();

  const out = captured.join("");
  // 历史块(user / thinking / assistant)进回卷
  expect(out).toContain("写个函数");
  expect(out).toContain("思考 (1.5s)");
  expect(out).toContain("完成");
  // live 流式增量出现
  expect(out).toContain("先想签名");
  expect(out).toContain("add(){}");
  // 固定底部条(header)
  expect(out).toContain("coderig");
  // 没有模态时不画输入提示符(那行留给活动行:模型忙时显示 spinner)
  expect(out).not.toContain("\n> ");
});

test("活动行:忙时有 spinner 帧 + 状态文案,idle 时不画", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  store.setActivity("thinking");
  await tick();
  const busy = captured.join("");
  expect(busy).toContain("思考中");
  expect(busy).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // cli-spinners dots 帧
  expect(busy).toMatch(/\d\.\ds/); // 已耗时

  captured = [];
  store.setActivity("idle");
  await tick();
  expect(captured.join("")).not.toContain("思考中");
  await app.unmount();
});

test("活动行:工具参数进度显示工具名与字符数(不落进回卷)", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  store.setActivity("tool_args", { label: "read_file", chars: 42 });
  await tick();
  const out = captured.join("");
  expect(out).toContain("read_file");
  expect(out).toContain("42 字符");
  expect(store.getBlocks()).toHaveLength(0); // 关键:瞬时状态不进历史块
  await app.unmount();
});

test("live 区限行:长 reasoning 只画尾部若干行", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  for (let i = 0; i < 40; i++) store.appendReasoning(`第${i}行\n`);
  await tick();
  const out = captured.join("");
  expect(out).toContain("第39行"); // 尾部在
  expect(out).not.toContain("第0行"); // 头部被裁掉,不会把输入行顶出屏幕
  await app.unmount();
});

test("app 首次空态不崩", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  await tick();
  await app.unmount();
  // 至少渲染了底部条
  expect(captured.join("")).toContain("coderig");
});

test("select 模态:open 后渲染选项列表,resolve 后清理", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  const p = store.openModal("select", {
    title: "批准?",
    options: [
      { value: "allow", label: "允许一次" },
      { value: "deny", label: "拒绝" },
    ],
  });
  await tick();
  expect(captured.join("")).toContain("允许一次");
  expect(captured.join("")).toContain("拒绝");
  store.resolveModal("allow");
  await tick();
  expect(await p).toBe("allow");
  await app.unmount();
});

test("text 模态:'\\n' 与 '\\r' 都算提交(Ink 只把 \\r 认成 return)", async () => {
  capture();
  const store = new TuiStore();
  // Ink 从 stdin 的 'readable' 事件 + read() 取输入,所以要一个真流(PassThrough)
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => {};
  stdin.unref = () => {};
  const app = render(<App store={store} />, {
    debug: true,
    stdin,
    isRawModeSupported: true,
  } as any);

  const p1 = store.openModal("text", { title: "" });
  await tick();
  stdin.write("hi");
  await tick();
  stdin.write("\n"); // 管道/pty 灌进来的换行
  expect(await p1).toBe("hi");

  const p2 = store.openModal("text", { title: "" });
  await tick();
  stdin.write("yo");
  await tick();
  stdin.write("\r"); // 真终端的回车
  expect(await p2).toBe("yo");

  // 管道/pty 常把"整行 + 尾部换行"一次灌进来:换行前的内容就是这一行
  const p3 = store.openModal("text", { title: "" });
  await tick();
  stdin.write("一整行\n");
  expect(await p3).toBe("一整行");
  await app.unmount();
});

test("text 模态:open 后渲染输入框并带光标", async () => {
  capture();
  const store = new TuiStore();
  const app = renderApp(store);
  const p = store.openModal("text", { title: "" });
  await tick();
  expect(captured.join("")).toContain("> ");
  store.resolveModal("hello");
  expect(await p).toBe("hello");
  await app.unmount();
});