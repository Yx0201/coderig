// ===== 工具调用分区:按"调用内容"细判并行 vs 串行 =====
//
// 原实现按 mutates 标记一刀切:只读并行、写串行。问题是 bash 永远是 mutates,
// 连只读的 `ls` 也被串行化。Claude Code 的 toolOrchestration 是逐调用解析输入、
// fail-closed 地判 `isConcurrencySafe`,这里做简化版:
//
//   - mutates=false                → parallel(并行)
//   - bash:命令 classifyBash 只读  → parallel;否则 serial_global(全局串行)
//   - write/edit:目标文件不同      → file_lock(不同文件可并行,同文件互斥)
//   - 参数解析失败/未知工具        → serial_global(fail-closed,保守)
//
// 分区是纯函数(可单测);执行编排在 chat.ts。

import type { ToolCall } from "../llm/types.ts";
import type { ToolEntry } from "./registry.ts";
import { classifyBash } from "./permissions.ts";

export type PartitionKind = "parallel" | "file_lock" | "serial_global";

export interface PartitionedCall {
  index: number; // 在 toolCallsToRun 里的原始下标(回填结果按它排序)
  toolCall: ToolCall;
  kind: PartitionKind;
  lockPath?: string; // kind=file_lock 时:目标文件路径(锁的 key,chat.ts 里 resolve 成绝对路径)
}

export function partitionToolCalls(
  toolCalls: readonly ToolCall[],
  getEntry: (name: string) => ToolEntry | undefined,
): PartitionedCall[] {
  return toolCalls.map((tc, index) => {
    const entry = getEntry(tc.function.name);
    // 未知工具:按串行处理(保守;反正会报"未知工具"回填)
    if (!entry) return { index, toolCall: tc, kind: "serial_global" };
    // 只读工具 → 并行
    if (!entry.mutates) return { index, toolCall: tc, kind: "parallel" };

    if (tc.function.name === "bash") {
      // bash:按命令内容细判 —— 只读命令可并行,否则全局串行
      let cmd = "";
      try {
        const args = JSON.parse(tc.function.arguments);
        cmd = typeof args?.command === "string" ? args.command : "";
      } catch {
        return { index, toolCall: tc, kind: "serial_global" }; // 解析失败 fail-closed
      }
      return classifyBash(cmd) === "readonly"
        ? { index, toolCall: tc, kind: "parallel" }
        : { index, toolCall: tc, kind: "serial_global" };
    }

    // write/edit(及任何有 path 参数的写工具):按目标文件加锁
    let path = "";
    try {
      const args = JSON.parse(tc.function.arguments);
      path = typeof args?.path === "string" ? args.path : "";
    } catch {
      return { index, toolCall: tc, kind: "serial_global" };
    }
    return path
      ? { index, toolCall: tc, kind: "file_lock", lockPath: path }
      : { index, toolCall: tc, kind: "serial_global" };
  });
}

// 把分区结果组织成"可并发批"(wave):批内全部并行,批间顺序 = 模型给出的顺序。
// 规则(对齐 Claude Code 的顺序敏感分段,保证语义不变):
//   - 连续只读 → 同一批,并发
//   - 连续写不同文件(file_lock 且 lockPath 互异)→ 同一批,并发
//   - 只读与写混排 → 不同批(保持"读先于写"或"写先于读"的模型顺序)
//   - 同 path 的写 → 不同批(互斥)
//   - serial_global → 独占一批(不与任何东西并发)
export function buildWaves(partitioned: PartitionedCall[]): PartitionedCall[][] {
  const waves: PartitionedCall[][] = [];
  let wave: PartitionedCall[] = [];
  const flush = () => {
    if (wave.length) {
      waves.push(wave);
      wave = [];
    }
  };

  for (const p of partitioned) {
    if (p.kind === "serial_global") {
      flush();
      waves.push([p]);
      continue;
    }
    if (wave.length === 0) {
      wave.push(p);
      continue;
    }
    const waveHasWrite = wave.some((w) => w.kind === "file_lock");
    if (p.kind === "parallel" && !waveHasWrite) {
      wave.push(p); // 只读堆只读
      continue;
    }
    if (
      p.kind === "file_lock" &&
      waveHasWrite &&
      wave.every(
        (w) => w.kind === "file_lock" && w.lockPath !== p.lockPath,
      )
    ) {
      wave.push(p); // 写堆写,但同 path 不同批
      continue;
    }
    // 类型切换或同 path:结算当前批,开新批
    flush();
    wave.push(p);
  }
  flush();
  return waves;
}

// 每文件锁:同一个 key(绝对路径)互斥,不同 key 并行。
// 当前是"防御性冗余"(评审 P2-7):并发安全由 buildWaves 保证(同 wave 内 lockPath
// 互异),withLock 实际拿不到已占用的锁。保留作为第二道保险,便于将来放宽 wave 规则
export class FileLocks {
  private locks = new Map<string, Promise<void>>();

  async withLock(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    // 链尾挂 catch:前一个任务抛错不能把整个锁链搞崩(下一位还能拿到 resolve 后的链)
    this.locks.set(key, next.catch(() => {}));
    return next;
  }
}
