import { test, expect, beforeEach, afterEach } from "bun:test";
import { Tracer } from "./tracer.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 约束2 门卫:displaySink 只是把"一次性终端提示行"重定向到别的出口(TUI notice 块),
// 绝不触碰持久化(persist → appendFile 写文件)。这两条独立,测试两侧各验一遍。

const origWrite = process.stdout.write.bind(process.stdout);
let captured: string[] = [];
function capture() {
  captured = [];
  (process.stdout as any).write = (chunk: any) => {
    captured.push(String(chunk));
    return true;
  };
}

// 每次测试一个独立 trace 文件,避免污染 ~/.coderig
let tracePath = "";
beforeEach(() => {
  tracePath = join(tmpdir(), `tracer-test-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.TRACE_PATH = tracePath;
});
afterEach(() => {
  (process.stdout as any).write = origWrite;
  delete process.env.TRACE_PATH;
});

// persist 走 appendFile 的 promise 链,给足时间让全部事件落地
const flush = () => new Promise((r) => setTimeout(r, 60));

// 去掉时间派生字段(duration/totalDuration),只留稳定的语义载荷做对比
function stripTime(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stripTime);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (/duration/i.test(k)) continue; // 匹配 duration / totalDuration
    out[k] = stripTime(val);
  }
  return out;
}

// 驱动一段固定序列的 helper:覆盖 4 个直写站点 + 若干只落盘事件
async function drive(t: Tracer) {
  t.startSession({ promptVersion: "test", systemPromptChars: 0, model: "m" });
  t.llmStart();
  t.userMessage("hi");
  t.toolCall("read_file", { path: "a.ts" }, "call-1");
  t.toolApproved("call-1");
  t.toolResult("read_file", "lines: 1", true, "call-1");
  t.toolCall("bash", { command: "rm x" }, "call-2");
  t.toolResult("bash", "错误：危险", false, "call-2");
  t.nudge("第1次 finish_reason=null");
  t.compaction({ cutIndex: 3, summaryLen: 40, promptTokens: 900000 });
  t.error("测试错误");
  t.llmEnd({ contentLen: 10, reasoningLen: 5, toolCallsCount: 2, finishReason: "tool_calls" });
  t.endSession();
}

async function readEvents() {
  const txt = await Bun.file(tracePath).text();
  return txt
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("自定义 displaySink 收到 4 条一次性提示,且 stdout 零输出(已重定向)", async () => {
  capture();
  const seen: string[] = [];
  const t = new Tracer({ displaySink: (s) => seen.push(s) });
  await drive(t);
  await flush();
  // 4 个直写站点都进了 displaySink
  expect(seen.some((s) => s.includes("🔧 read_file"))).toBe(true);
  expect(seen.some((s) => s.includes("🔧 bash"))).toBe(true);
  expect(seen.some((s) => s.includes("↻ 续轮提示"))).toBe(true);
  expect(seen.some((s) => s.includes("⊘ 上下文压缩"))).toBe(true);
  expect(seen.some((s) => s.includes("✓ 完成"))).toBe(true);
  // 全被重定向 → stdout 一个字节都没写
  expect(captured.join("")).toBe("");
});

test("默认 displaySink 直接写 stdout(线性字节与改造前一致)", async () => {
  capture();
  const t = new Tracer(); // 默认 sink = process.stdout.write
  await drive(t);
  await flush();
  expect(captured.join("")).toContain("🔧 read_file");
  expect(captured.join("")).toContain("✓ 完成");
});

test("displaySink 不影响持久化:两种 sink 落盘事件完全一致", async () => {
  const probe = "probe-sink-" + Math.random().toString(36).slice(2);
  tracePath = join(tmpdir(), `tracer-test-${probe}.jsonl`);
  process.env.TRACE_PATH = tracePath;

  const tNoSink = new Tracer();
  await drive(tNoSink);
  await flush();
  const eventsNoSink = await readEvents();

  // 重跑一份,用重定向 sink
  tracePath = join(tmpdir(), `tracer-test-${probe}b.jsonl`);
  process.env.TRACE_PATH = tracePath;
  const tWithSink = new Tracer({ displaySink: () => {} });
  await drive(tWithSink);
  await flush();
  const eventsWithSink = await readEvents();

  // 事件数一致
  expect(eventsWithSink.length).toBe(eventsNoSink.length);
  // 关键字段逐条一致:类型 + 稳定数据。时间派生字段(duration/totalDuration)随
  // 运行时刻不同,不能比;它们不是"displaySink 影响持久化"的观测目标
  eventsNoSink.forEach((a, i) => {
    const b = eventsWithSink[i]!;
    expect(b.type).toBe(a.type);
    expect(stripTime(a.data)).toEqual(stripTime(b.data));
  });
  // seq 在各自会话内连续(0..n)
  eventsWithSink.forEach((e, i) => expect(e.seq).toBe(i + 1));
});
test("结构化 toolDisplaySink:拿到字段而非成品行,且文本 sink 不再收工具行", async () => {
  capture();
  const lines: string[] = [];
  const tools: any[] = [];
  const t = new Tracer({ displaySink: (s) => lines.push(s) });
  t.setToolDisplaySink((info) => tools.push(info));
  await drive(t);
  await flush();
  // 工具结果走结构化出口:渲染层自己决定怎么画(TUI 只画名字+结果,不吐参数)
  expect(tools.map((x) => x.name)).toEqual(["read_file", "bash"]);
  expect(tools[0].ok).toBe(true);
  expect(tools[1].ok).toBe(false);
  expect(typeof tools[0].duration).toBe("number");
  // 同一条不会重复走文本 sink(否则回卷里一条工具出现两次)
  expect(lines.some((s) => s.includes("🔧"))).toBe(false);
  // 其余 3 条一次性提示照旧走文本 sink
  expect(lines.some((s) => s.includes("↻ 续轮提示"))).toBe(true);
  expect(captured.join("")).toBe("");
});

test("toolDisplaySink 不影响落盘:tool_result 事件照旧完整", async () => {
  const t = new Tracer({ displaySink: () => {} });
  t.setToolDisplaySink(() => {});
  await drive(t);
  await flush();
  const results = (await readEvents()).filter((e) => e.type === "tool_result");
  expect(results.length).toBe(2);
  expect(results[0].data.name).toBe("read_file");
  expect(results[0].data.ok).toBe(true);
  expect(results[1].data.ok).toBe(false);
});
