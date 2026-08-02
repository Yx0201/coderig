// ===== 终端宽度的唯一读取点 =====
//
// markdown 的表格/代码块框线、工具卡片的截断都要按"当前终端多宽"算。直接读
// process.stdout.columns 有两个坑:非 TTY(管道/测试)下是 undefined;窄到 20 列时
// 框线算出负宽会崩。集中在这里兜一次,别在各处重复三元表达式。

const DEFAULT_COLUMNS = 80;
const MIN_COLUMNS = 24;

export function termWidth(): number {
  // 非 TTY 下 stdout.columns 是 undefined,退到 COLUMNS 环境变量(测试/CI 里能显式指定宽度)
  const c = process.stdout.columns || Number(process.env.COLUMNS);
  if (!c || !Number.isFinite(c)) return DEFAULT_COLUMNS;
  return Math.max(MIN_COLUMNS, Math.floor(c));
}
