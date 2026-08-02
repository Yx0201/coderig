import { test, expect, afterEach } from "bun:test";
import { renderLoading } from "./render.ts";

// 捕获 stdout.write:spinner 的行为全靠写了哪些控制序列体现,
// 没法看"屏幕",只能断言字节流
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

test("loading:done 清行后写文案并换行(状态定格留在视图上)", () => {
  capture();
  const l = renderLoading();
  l.done("思考完成");
  const out = captured.join("");
  expect(out).toContain(CLEAR);
  expect(out).toContain("思考完成");
  expect(out.endsWith("\n")).toBe(true);
  expect(l.isRunning()).toBe(false);
});

// 这条是"思考完成"能留在屏幕上的关键不变量:
// 主循环里 done 之后紧跟一个兜底 stop(),stop 若不幂等就会把刚定格的行擦掉
test("loading:done 之后 stop 是 no-op(不擦掉已定格的文案)", () => {
  capture();
  const l = renderLoading();
  l.done("思考完成");
  const afterDone = captured.length;
  l.stop();
  expect(captured.length).toBe(afterDone); // 一个字节都不该再写
});

test("loading:未启动时 stop 不输出任何东西", () => {
  capture();
  const l = renderLoading();
  l.stop();
  expect(captured.join("")).toBe("");
});

test("loading:start 幂等(重复调用不叠计时器)", () => {
  capture();
  const l = renderLoading();
  l.start();
  l.start();
  expect(l.isRunning()).toBe(true);
  l.stop();
  expect(l.isRunning()).toBe(false); // 若叠了两个 timer,单次 stop 停不干净
});

test("loading:stop 会清掉 spinner 占的那一行", () => {
  capture();
  const l = renderLoading();
  l.start();
  captured = [];
  l.stop();
  expect(captured.join("")).toBe(CLEAR);
});

test("loading:清行用 ANSI 擦除而非填空格(窄终端下填空格会折行)", async () => {
  capture();
  const l = renderLoading("正在思考…");
  l.start();
  await new Promise((r) => setTimeout(r, 120)); // 等至少一帧
  l.stop();
  const out = captured.join("");
  expect(out).toContain(CLEAR);
  expect(out).toContain("正在思考…");
  expect(out).not.toContain("          "); // 不该出现成串空格填充
});
