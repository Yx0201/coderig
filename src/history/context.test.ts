import { test, expect } from "bun:test";
import { pickCutIndex, buildContextView, hasOversizedMsg } from "./context.ts";
import type { ChatMessage } from "../llm/types.ts";

// context.ts 全是纯函数(输入输出确定、不碰 IO),边界条件却很微妙:
// 切点会不会把 tool 消息和它的 assistant 拆开、单条超大消息会不会把 tail 压成空、
// 压缩后的视图还满不满足"每个 tool 消息前必须有对应 assistant"的协议约束。
// 这些用例锁住的是协议正确性——它们失败意味着请求会被 API 拒(400),不是风格问题。

const user = (content: string): ChatMessage => ({ role: "user", content });
const asst = (content: string): ChatMessage => ({ role: "assistant", content });
// 带 tool_calls 的 assistant + 对应的 tool 结果,是最容易被切点拆坏的一对
const asstCall = (id: string, name = "read_file", args = '{"path":"a.ts"}'): ChatMessage => ({
  role: "assistant",
  content: "",
  reasoning_content: "先读文件", // DeepSeek 要求随 tool_calls 一起回传
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const toolRes = (id: string, content: string, name = "read_file"): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  name,
  content,
});

// 视图的协议自检:每个 tool 消息前面必须有带对应 tool_call_id 的 assistant,
// 且每个 assistant 的 tool_calls 都得有回应。违反任一条,API 直接 400
function assertProtocolValid(view: ChatMessage[]) {
  const seen = new Set<string>();
  for (const [i, m] of view.entries()) {
    if (m.role === "assistant")
      for (const tc of m.tool_calls ?? []) seen.add(tc.id);
    if (m.role === "tool") {
      expect(m.tool_call_id, `view[${i}] 是 tool 但没有 tool_call_id`).toBeTruthy();
      expect(
        seen.has(m.tool_call_id!),
        `view[${i}] 的 tool_call_id=${m.tool_call_id} 没有在它之前的 assistant 里出现(孤儿 tool)`,
      ).toBe(true);
    }
  }
}

test("空历史:切点为 0,视图为空", () => {
  expect(pickCutIndex([], 0)).toBe(0);
  expect(buildContextView([], null)).toEqual([]);
});

test("短历史:条数不足下界时不压缩(返回值 <= prevCut,调用方据此跳过)", () => {
  const msgs = [user("hi"), asst("hello")];
  expect(pickCutIndex(msgs, 0)).toBeLessThanOrEqual(0);
});

test("切点不会让 tail 以 tool 消息开头(否则 tool 成孤儿,API 400)", () => {
  // 构造:大量 assistant(tool_calls)+tool 对,每对都很大,逼切点落在对的中间
  const msgs: ChatMessage[] = [user("开始")];
  for (let i = 0; i < 12; i++) {
    msgs.push(asstCall(`call_${i}`));
    msgs.push(toolRes(`call_${i}`, "x".repeat(20_000))); // 每条都超尾部预算
  }
  const cut = pickCutIndex(msgs, 0);
  expect(msgs[cut]?.role).not.toBe("tool");
  assertProtocolValid(buildContextView(msgs, { cutIndex: cut, summary: "早期摘要" }));
});

test("单条超大消息不会把 tail 压成空(MIN_TAIL_MSGS 下界生效)", () => {
  // 一条 50 万字符的粘贴日志,自己就能吃满任何尾部预算。
  // 只按体积算切点的话会被推到数组末尾,模型只看到摘要、看不到当前工作现场
  const msgs: ChatMessage[] = [
    ...Array.from({ length: 10 }, (_, i) => user(`早期消息 ${i}`)),
    user("x".repeat(500_000)),
    asst("收到"),
  ];
  const cut = pickCutIndex(msgs, 0);
  expect(cut).toBeLessThan(msgs.length); // 没被推到末尾
  const view = buildContextView(msgs, { cutIndex: cut, summary: "摘要" });
  expect(view.length).toBeGreaterThan(1); // 摘要之外还有原文
});

test("超大单条消息在视图里被就地截断(含最新那条——超大粘贴总是最新的)", () => {
  const huge = "y".repeat(500_000);
  const msgs = [user("前言"), user(huge)];
  const view = buildContextView(msgs, null);
  const last = view.at(-1)!;
  expect(last.content.length).toBeLessThan(huge.length); // 被截了
  expect(last.content).toContain("已省略"); // 且明确告知模型丢了内容
  expect(hasOversizedMsg(msgs, 0)).toBe(true);
});

test("压缩视图 = 摘要 + 尾部原文,且摘要在最前", () => {
  const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) =>
    i % 2 === 0 ? user(`问 ${i}`) : asst(`答 ${i}`),
  );
  const view = buildContextView(msgs, { cutIndex: 10, summary: "前十条的摘要" });
  expect(view[0]!.content).toContain("前十条的摘要");
  expect(view.length).toBe(1 + (msgs.length - 10));
});

test("reasoning_content 必须原样穿过视图(DeepSeek 硬约束,丢了就 400)", () => {
  const msgs = [
    user("读文件"),
    asstCall("call_1"),
    toolRes("call_1", "内容"),
    ...Array.from({ length: 15 }, (_, i) => user(`后续 ${i}`)), // 把上面那条推成"旧消息"
  ];
  const view = buildContextView(msgs, null);
  const withCalls = view.find((m) => m.tool_calls?.length);
  expect(withCalls?.reasoning_content).toBe("先读文件");
});

test("旧的超长 tool_calls.arguments 被裁剪,但工具名与调用痕迹保留", () => {
  const bigContent = JSON.stringify({ path: "a.ts", content: "z".repeat(50_000) });
  const msgs = [
    user("写文件"),
    asstCall("call_1", "write_file", bigContent),
    toolRes("call_1", "已写入", "write_file"),
    ...Array.from({ length: 15 }, (_, i) => user(`后续 ${i}`)),
  ];
  const view = buildContextView(msgs, null);
  const m = view.find((v) => v.tool_calls?.length)!;
  const args = m.tool_calls![0]!.function.arguments;
  expect(m.tool_calls![0]!.function.name).toBe("write_file"); // 行动痕迹在
  expect(args).toContain("a.ts"); // 短字段(路径)保留
  expect(args.length).toBeLessThan(bigContent.length); // 长字段被换成占位符
});

test("连续压缩单调推进(prevCut 之后每次都有进展或明确无进展)", () => {
  const msgs: ChatMessage[] = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0 ? user(`问 ${i}`.repeat(200)) : asst(`答 ${i}`.repeat(200)),
  );
  let prev = 0;
  for (let round = 0; round < 5; round++) {
    const cut = pickCutIndex(msgs, prev);
    if (cut <= prev) break; // 无可压增量,合法终止
    expect(cut).toBeGreaterThan(prev); // 有进展就必须严格前进,不能原地打转
    prev = cut;
    assertProtocolValid(buildContextView(msgs, { cutIndex: cut, summary: "s" }));
  }
});

test("续话遇上次被中断的转录:未回应的 tool_calls 在视图层被补齐", () => {
  // 上次运行在"工具执行中"被 ctrl+C/崩溃打断:assistant(tool_calls) 已落盘、
  // tool 结果还没写。续话原样发出去 API 直接 400
  const msgs = [user("读文件"), asstCall("call_1"), user("续话后的新问题")];
  const view = buildContextView(msgs, null);
  assertProtocolValid(view);
  const synth = view.find((m) => m.role === "tool" && m.tool_call_id === "call_1")!;
  expect(synth).toBeTruthy();
  expect(synth.content).toContain("未完成"); // 明确告知模型该重试,而非当成已完成
  // 合成的 tool 必须紧跟它的 assistant,不能被挤到末尾
  const ai = view.findIndex((m) => m.tool_calls?.length);
  expect(view[ai + 1]).toBe(synth);
});

test("一个 assistant 多个 tool_calls 只断了一部分:只补缺的那些", () => {
  const msgs: ChatMessage[] = [
    user("并行读两个文件"),
    {
      role: "assistant",
      content: "",
      reasoning_content: "并行读",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    toolRes("c1", "第一个的结果"), // c2 的结果缺失(进程在这里被打断)
  ];
  const view = buildContextView(msgs, null);
  assertProtocolValid(view);
  const c1 = view.filter((m) => m.tool_call_id === "c1");
  const c2 = view.filter((m) => m.tool_call_id === "c2");
  expect(c1.length).toBe(1); // 已有的不重复补
  expect(c1[0]!.content).toBe("第一个的结果"); // 且原文不被改写
  expect(c2.length).toBe(1); // 缺的补上
  expect(c2[0]!.content).toContain("未完成");
});

test("压缩 + 断连同时发生:摘要在最前,合成 tool 仍紧跟其 assistant", () => {
  const msgs: ChatMessage[] = [
    ...Array.from({ length: 10 }, (_, i) => user(`早期 ${i}`)),
    asstCall("call_x"), // 尾部有个断掉的调用
  ];
  const view = buildContextView(msgs, { cutIndex: 8, summary: "早期摘要" });
  expect(view[0]!.content).toContain("早期摘要"); // 摘要仍在最前
  assertProtocolValid(view);
});

test("旧转录里非法的 cutIndex(指向 tool 消息)被视图兜住", () => {
  // 旧版本 harness 写下的 compaction 行可能把切点指在 tool 上,
  // 加载后不能直接拿去发请求——buildContextView 要再兜一次
  const msgs = [user("q"), asstCall("call_1"), toolRes("call_1", "r"), asst("done")];
  const view = buildContextView(msgs, { cutIndex: 2, summary: "摘要" }); // 2 是 tool
  assertProtocolValid(view);
});
