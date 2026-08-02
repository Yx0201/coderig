import { test, expect, afterEach } from "bun:test";
import { LinearTerm } from "./linearTerm.ts";

// 捕获 stdout.write:线性渲染的字节靠断言字节流,没法看"屏幕"
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

const CLEAR = "\x1b[2K\r";

// 确定性 fake loader:只记录方法调用顺序(spinner 的真实字节由 render.test 覆盖,
// 这里验证的是 LinearTerm 状态机 —— 思考何时进入、何时定格、进度何时复位)
function makeLoader() {
  const calls: string[] = [];
  let running = false;
  return {
    calls,
    setMessage: (m: string) => calls.push(`setMessage(${m})`),
    isRunning: () => running,
    start: () => {
      calls.push("start");
      running = true;
    },
    stop: () => {
      if (running) {
        calls.push("stop");
        running = false;
      }
    },
    done: (msg: string) => {
      calls.push(`done(${msg})`);
      running = false;
    },
  };
}

test("思考→正文:进入 thinking,content 先定格再输出,尾部 end/stop 不再动", () => {
  capture();
  const loader = makeLoader();
  const t = new LinearTerm(loader as any);
  t.start(); // [start]
  t.onReasoning("第一部分思考"); // 进入 thinking:setMessage(正在思考…),start
  t.onReasoning("更多思考"); // thinking 已开:不再重复 setMessage/start
  t.onContent("你好\n"); // finishThinking → done(思考完成); 写正文; thinking 关
  t.end(); // 无 thinking → no-op
  t.stop(); // running=false → no-op

  expect(loader.calls).toEqual([
    "start",
    "setMessage(正在思考…)",
    "start",
    "done(思考完成)",
  ]);
  // 正文字节原样写出去,没被定格文案污染
  expect(captured.join("")).toBe("你好\n");
});

test("无思考直接出结果:onContent 只停不 done", () => {
  capture();
  const loader = makeLoader();
  const t = new LinearTerm(loader as any);
  t.start();
  t.onContent("hi");
  t.stop();
  expect(loader.calls).toEqual(["start", "stop"]);
  expect(captured.join("")).toBe("hi");
});

test("收尾轮只有内容:多轮 onContent 只停一次(幂等)", () => {
  capture();
  const loader = makeLoader();
  const t = new LinearTerm(loader as any);
  t.start();
  t.onContent("a");
  t.onContent("b");
  expect(loader.calls).toEqual(["start", "stop"]); // 第二次 stop 是 no-op
  expect(captured.join("")).toBe("ab");
});

test("工具进度:光标不在行首先补 \\n,之后原地 CLEAR 刷新", () => {
  capture();
  const t = new LinearTerm();
  t.onContent("hi"); // 无换行结尾 → atLineStart=false
  t.onToolCallProgress("read_file", 10);
  t.onToolCallProgress("read_file", 42); // 已占行 → 不再补 \n
  const out = captured.join("");
  expect(out).toContain("\n" + CLEAR);
  expect(out).toContain("read_file");
  expect(out).toContain(" 10 字符");
  // 只有一处补行\n(第二次数值变化原地刷新)
  expect(out.split("\n").length).toBe(2);
});

test("正文以换行结尾后接进度:atLineStart=true → 不再补 \\n", () => {
  capture();
  const t = new LinearTerm();
  t.onContent("hi\n"); // 自带换行 → atLineStart=true
  t.onToolCallProgress("write_file", 5);
  const out = captured.join("");
  expect(out).toContain(CLEAR);
  // 内容自带一个换行;若进度再补 \n 会成 2 个
  expect((out.match(/\n/g) ?? []).length).toBe(1);
  expect(out).toContain("write_file");
});

test("思考复苏后进度不再补行:finishThinking 把 atLineStart 拉回 true", () => {
  capture();
  const loader = makeLoader();
  const t = new LinearTerm(loader as any);
  t.onContent("a"); // atLineStart=false
  t.onToolCallProgress("x", 1); // atLineStart=false → 补 \n 占行
  t.onReasoning("想"); // progressActive=false 复位
  t.onToolCallProgress("x", 2); // finishThinking 拉回 atLineStart=true → 不再补 \n
  const out = captured.join("");
  // 只有头一个进度补了一次 \n(思考收尾已换行,第二个进度不叠加空行)
  expect((out.match(/\n/g) ?? []).length).toBe(1);
});

test("onRetry:打重试提示并复位 spinner 为等待重发", () => {
  capture();
  const loader = makeLoader();
  const t = new LinearTerm(loader as any);
  t.start();
  t.onRetry({
    attempt: 2,
    maxAttempts: 3,
    delayMs: 2500,
    reason: "HTTP 429",
  });
  // spinner:start → 先 stop(收尾旧 spinner) → setMessage("") + start(重新等退避)
  expect(loader.calls).toEqual(["start", "stop", "setMessage()", "start"]);
  const out = captured.join("");
  expect(out).toContain("⟳ 请求失败(HTTP 429),2.5s 后重试(2/3)");
});

test("notify/error 字节复刻 render 助手", () => {
  capture();
  const t = new LinearTerm();
  t.notify("hello\n");
  t.notify("\n⊘ 压缩中…\n", "dim");
  t.notify(""); // 空 → 单独换行
  const out = captured.join("");
  expect(out.startsWith("hello\n")).toBe(true);
  expect(out).toContain("⊘ 压缩中…");
  expect(out).toContain("\n\n"); // hello\n + 空 notify 的 \n
});