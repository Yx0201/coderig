// ===== tracer 展示出口 → notice 块 =====
//
// TUI 模式下,tracer 那 4 条"一次性提示行"(tool_result / nudge / compaction /
// session_end 汇总)不再直接写 process.stdout(那会污染 Ink 帧),改走 displaySink
// 塞进 TuiStore 的 notice 块 → <Static> 回卷。持久化(appendFile 写 trace.jsonl)
// 与之完全解耦,displaySink 只影响"往哪画"。

import type { TuiStore } from "./store.ts";
import type { Tracer } from "../../observability/tracer.ts";

export function routeTracerToStore(tracer: Tracer, store: TuiStore) {
  tracer.setDisplaySink((text) => store.pushNotice(text));
  // 工具结果走结构化 sink → 工具卡片块(只画"工具名 + 结果摘要 + 耗时",不吐参数原文:
  // 参数是给日志看的,屏幕上一行 JSON 挤掉三行结果反而更难读)
  tracer.setToolDisplaySink((info) =>
    store.pushTool(info.name, info.result, info.ok, info.duration),
  );
}