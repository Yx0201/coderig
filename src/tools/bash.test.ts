import { test, expect } from "bun:test";
import { bashHandler } from "./bash.ts";
import { createSessionContext } from "./context.ts";

const ctx = createSessionContext({});

test("bash:cwd 不存在返回错误而非抛异常(评审 P1-4)", async () => {
  // 修复前 Bun.spawn 会在 try 外抛 ENOENT(posix_spawn 'sh'),报错误导;
  // 现在显式校验走"错误："前缀
  const r = await bashHandler(
    { command: "pwd", cwd: "/no/such/dir-xyz" },
    ctx,
  );
  expect(r).toContain("错误");
  expect(r).toContain("cwd 不存在");
});

test("bash:cwd 参数生效(不写 cd … &&)", async () => {
  const r = await bashHandler({ command: "pwd", cwd: "/tmp" }, ctx);
  expect(r).not.toContain("错误");
});
