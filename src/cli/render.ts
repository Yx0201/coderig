import pc from "picocolors";
import cliSpinners from "cli-spinners";

export function renderInfo(msg: string) {
  process.stdout.write(`${pc.gray(msg)} \n`);
}
export function renderWarning(msg: string) {
  process.stdout.write(`${pc.yellow(msg)} \n`);
}
export function renderError(msg: string) {
  process.stdout.write(`${pc.red(msg)} \n`);
}

export function renderSuccess(msg: string) {
  process.stdout.write(`${pc.green(msg)} \n`);
}

// 清当前行:用 ANSI \x1b[2K(整行擦除)而不是打一串空格。
// 空格方案在终端宽度小于填充长度时会折行,\r 只回到折行后那行的行首,
// 原行擦不掉——这正是"正在思考"残留过的原因
const CLEAR_LINE = "\x1b[2K\r";

export function renderLoading(message = "") {
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentMessage = message;
  return {
    // 运行时换 spinner 旁的文字(如请求中 → 正在思考):下一帧即生效
    setMessage: (m: string) => {
      currentMessage = m;
    },
    isRunning: () => timer !== null,
    start: () => {
      if (timer) return; // 幂等:重复 start 不叠计时器(否则多个 timer 抢同一行)
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % cliSpinners.dots.frames.length;
        process.stdout.write(
          CLEAR_LINE +
            pc.cyan(cliSpinners.dots.frames[frameIndex]) +
            (currentMessage ? ` ${currentMessage}` : ""),
        );
      }, cliSpinners.dots.interval);
    },
    stop: () => {
      // 幂等:只在 spinner 还在转时停并清行。已停时 no-op,
      // 让多处收尾路径都能放心调用而不产生多余空行
      if (timer) {
        clearInterval(timer);
        timer = null;
        process.stdout.write(CLEAR_LINE);
      }
    },
    // 停 spinner 但不把行留空,而是原地重绘成最终文案(如"思考完成")并换行,
    // 让这行状态留在视图上。与 stop() 的区别:stop 擦掉,done 定格
    done: (message: string) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write(CLEAR_LINE + pc.dim(message) + "\n");
    },
  };
}
