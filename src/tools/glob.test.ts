import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globHandler } from "./glob.ts";
import { createSessionContext } from "./context.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

const ctx = createSessionContext({}); // 读类工具不碰 ctx,传空即可满足签名

test("glob:正常匹配(递归 + 排除 node_modules)", async () => {
  const dir = makeTmp();
  try {
    await Promise.all([
      Bun.write(join(dir, "a.ts"), "x"),
      Bun.write(join(dir, "sub", "b.ts"), "x"),
      Bun.write(join(dir, "node_modules", "skip.ts"), "x"),
    ]);
    const r = await globHandler({ pattern: "**/*.ts", path: dir }, ctx);
    expect(r).toContain("a.ts");
    expect(r).toContain("b.ts");
    expect(r).not.toContain("skip.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("glob:结果超过上限截断并提示", async () => {
  const dir = makeTmp();
  try {
    // 一次性建 210 个文件,不逐个 await
    await Promise.all(
      Array.from({ length: 210 }, (_, i) => Bun.write(join(dir, `f${i}.ts`), "x")),
    );
    const r = await globHandler({ pattern: "**/*.ts", path: dir }, ctx);
    expect(r).toContain("结果过多");
    const files = r.split("\n").filter((l) => l.startsWith("f") && !l.startsWith("..."));
    expect(files.length).toBe(200); // 恰好只显示前 200 条
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
