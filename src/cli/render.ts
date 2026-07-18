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

export function renderLoading() {
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start: () => {
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % cliSpinners.dots.frames.length;
        process.stdout.write("\r" + " ".repeat(50) + "\r");
        process.stdout.write(pc.cyan(cliSpinners.dots.frames[frameIndex]));
      }, cliSpinners.dots.interval);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stdout.write("\r" + " ".repeat(50) + "\r");
    },
  };
}
