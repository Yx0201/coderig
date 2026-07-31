// ===== doom loop 检测(纯函数,与 chat.ts 的交互逻辑分开) =====
//
// 模型陷入"失败 → 原样重试"时,会连续多次发出完全相同的工具调用(同名同参),
// 每轮白烧一轮 prompt tokens。opencode 的阈值是 3,gemini-cli 是 5。
// 取 3:重复调用也可能是合法的(连续 git status、分页读同一文件的不同段参数不同),
// 阈值高了多烧的轮数是实打实的成本,误伤靠"问用户"兜底而不是靠拉高阈值

export const DOOM_LOOP_THRESHOLD = 3;

export interface CallSig {
  name: string;
  args: string; // 原始 arguments JSON 字符串,不 parse——语义等价但格式不同的也算不同,宁可漏检
}

// 序列末尾是否连续 N 次完全相同的调用。
// 只在末尾看:历史中间出现过重复不算(可能早已恢复),当前正在重复才是死循环
export function isDoomLoop(
  calls: readonly CallSig[],
  threshold = DOOM_LOOP_THRESHOLD,
): boolean {
  if (calls.length < threshold) return false;
  const tail = calls.slice(-threshold);
  const first = tail[0]!;
  return tail.every((c) => c.name === first.name && c.args === first.args);
}
