import { test, expect, describe } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { coderigHome, tracePath, historyDir } from "./paths.ts";

// 路径收敛的产品承诺:状态一律进 ~/.coderig/,不污染用户项目目录。
// 这组测试锁住"默认落在 home 而不是 cwd"——如果哪天又改回相对路径,
// 跑在别人项目里就会往人家仓库里拉 logs/ 垃圾。
// paths.ts 是惰性函数(见该文件的设计说明),测试里改 env 立即生效

describe("config/paths", () => {
  test("coderigHome 默认落在用户主目录,不是 cwd", () => {
    const saved = process.env.CODERIG_HOME;
    delete process.env.CODERIG_HOME;
    expect(coderigHome()).toBe(join(homedir(), ".coderig"));
    expect(coderigHome().startsWith(process.cwd())).toBe(false);
    if (saved) process.env.CODERIG_HOME = saved;
  });

  test("CODERIG_HOME 环境变量可覆盖", () => {
    process.env.CODERIG_HOME = "/tmp/test-coderig";
    expect(coderigHome()).toBe("/tmp/test-coderig");
    delete process.env.CODERIG_HOME;
  });

  test("tracePath / historyDir 默认在 coderigHome 下", () => {
    delete process.env.CODERIG_HOME;
    delete process.env.TRACE_PATH;
    delete process.env.HISTORY_DIR;
    expect(tracePath()).toBe(join(coderigHome(), "trace.jsonl"));
    expect(historyDir()).toBe(join(coderigHome(), "history"));
  });

  test("TRACE_PATH / HISTORY_DIR 环境变量可独立覆盖", () => {
    process.env.TRACE_PATH = "/tmp/custom-trace.jsonl";
    process.env.HISTORY_DIR = "/tmp/custom-history";
    expect(tracePath()).toBe("/tmp/custom-trace.jsonl");
    expect(historyDir()).toBe("/tmp/custom-history");
    delete process.env.TRACE_PATH;
    delete process.env.HISTORY_DIR;
  });
});
