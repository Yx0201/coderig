import { test, expect } from "bun:test";
import { partitionToolCalls, buildWaves, FileLocks } from "./partition.ts";
import type { ToolCall } from "../llm/types.ts";
import type { ToolEntry } from "./registry.ts";

// 构造工具调用的辅助:name + args → ToolCall
const call = (name: string, args: object, id = "c"): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

// 假注册表:只有名字与 mutates 对分区逻辑有意义
const entries = new Map<string, ToolEntry>([
  ["read_file", { def: undefined as never, handler: async () => "" }],
  ["bash", { def: undefined as never, handler: async () => "", mutates: true }],
  ["edit_file", { def: undefined as never, handler: async () => "", mutates: true }],
  ["write_file", { def: undefined as never, handler: async () => "", mutates: true }],
]);
const getEntry = (n: string) => entries.get(n);

test("只读工具 → parallel", () => {
  const p = partitionToolCalls([call("read_file", { path: "a.ts" })], getEntry);
  expect(p[0]!.kind).toBe("parallel");
});

test("bash 只读命令 → parallel(按调用内容细判)", () => {
  const p = partitionToolCalls([call("bash", { command: "ls" })], getEntry);
  expect(p[0]!.kind).toBe("parallel");
});

test("bash 危险命令 → serial_global", () => {
  const p = partitionToolCalls([call("bash", { command: "rm -rf x" })], getEntry);
  expect(p[0]!.kind).toBe("serial_global");
});

test("bash 参数解析失败 → serial_global(fail-closed)", () => {
  const tc: ToolCall = {
    id: "c",
    type: "function",
    function: { name: "bash", arguments: "{not json" },
  };
  const p = partitionToolCalls([tc], getEntry);
  expect(p[0]!.kind).toBe("serial_global");
});

test("write/edit 带 path → file_lock 且带 lockPath", () => {
  const p = partitionToolCalls(
    [call("edit_file", { path: "a.ts", newString: "x" })],
    getEntry,
  );
  expect(p[0]!.kind).toBe("file_lock");
  expect(p[0]!.lockPath).toBe("a.ts");
});

test("未知工具 → serial_global(保守)", () => {
  const p = partitionToolCalls([call("not_a_tool", {})], getEntry);
  expect(p[0]!.kind).toBe("serial_global");
});

test("buildWaves:连续只读 → 同一批并发", () => {
  const waves = buildWaves(
    partitionToolCalls(
      [
        call("read_file", { path: "a.ts" }),
        call("read_file", { path: "b.ts" }),
        call("bash", { command: "ls" }),
      ],
      getEntry,
    ),
  );
  expect(waves.length).toBe(1);
  expect(waves[0]!.length).toBe(3);
});

test("buildWaves:不同文件写 → 同一批", () => {
  const waves = buildWaves(
    partitionToolCalls(
      [
        call("edit_file", { path: "a.ts", newString: "x" }),
        call("write_file", { path: "b.ts", content: "y" }),
      ],
      getEntry,
    ),
  );
  expect(waves.length).toBe(1);
  expect(waves[0]!.length).toBe(2);
});

test("buildWaves:同 path 写 → 拆两批(互斥)", () => {
  const waves = buildWaves(
    partitionToolCalls(
      [
        call("edit_file", { path: "a.ts", newString: "x" }),
        call("edit_file", { path: "a.ts", newString: "y" }),
      ],
      getEntry,
    ),
  );
  expect(waves.length).toBe(2);
});

test("buildWaves:只读与写混排 → 不同批,顺序保持", () => {
  const waves = buildWaves(
    partitionToolCalls(
      [
        call("bash", { command: "grep x a.ts" }), // 只读,先执行
        call("edit_file", { path: "a.ts", newString: "y" }),
      ],
      getEntry,
    ),
  );
  expect(waves.length).toBe(2);
  // 批 1 是只读 bash,批 2 是写——模型顺序(读先写后)保留
  expect(waves[0]![0]!.toolCall.function.name).toBe("bash");
  expect(waves[1]![0]!.toolCall.function.name).toBe("edit_file");
});

test("buildWaves:serial_global 独占一批", () => {
  const waves = buildWaves(
    partitionToolCalls(
      [
        call("bash", { command: "ls" }),
        call("bash", { command: "rm -rf x" }),
        call("read_file", { path: "a.ts" }),
      ],
      getEntry,
    ),
  );
  expect(waves.length).toBe(3); // 只读批 / rm 独批 / 只读批
  expect(waves[1]![0]!.toolCall.function.name).toBe("bash");
  expect(waves[1]![0]!.toolCall.function.arguments).toContain("rm");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("FileLocks:同 key 互斥(第二个等第一个完成)", async () => {
  const locks = new FileLocks();
  const order: string[] = [];
  const task = (name: string, ms: number) =>
    locks.withLock("same", async () => {
      order.push(name + ":start");
      await sleep(ms);
      order.push(name + ":end");
    });
  await Promise.all([task("a", 30), task("b", 1)]);
  // 同 key:严格串行 → a 完整结束后 b 才开始
  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
});

test("FileLocks:异 key 并行", async () => {
  const locks = new FileLocks();
  const order: string[] = [];
  const task = (key: string, name: string, ms: number) =>
    locks.withLock(key, async () => {
      order.push(name + ":start");
      await sleep(ms);
      order.push(name + ":end");
    });
  await Promise.all([task("a", "a", 30), task("b", "b", 1)]);
  // 异 key:并发 → a 先 start,但 a 未 end 时 b 已 start
  expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("b:start"));
  expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
});
