import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listDirHandler } from "./list_dir.ts";
import { createSessionContext } from "./context.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

const ctx = createSessionContext({}); // list_dir 不碰 ctx,传空即可满足签名

test("list_dir:正常列目录(非递归)", async () => {
  const dir = makeTmp();
  try {
    await Promise.all([
      Bun.write(join(dir, "a.ts"), "x"),
      Bun.write(join(dir, "sub", "b.ts"), "x"),
    ]);
    const r = await listDirHandler({ path: dir }, ctx);
    expect(r).toContain("a.ts");
    expect(r).toContain("sub"); // 一层列出子目录名
    expect(r).not.toContain("b.ts"); // 非递归不深入
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_dir:条目超过上限截断并提示", async () => {
  const dir = makeTmp();
  try {
    await Promise.all(
      Array.from({ length: 510 }, (_, i) => Bun.write(join(dir, `f${i}.ts`), "x")),
    );
    const r = await listDirHandler({ path: dir, recursive: true }, ctx);
    expect(r).toContain("条目过多");
    const files = r.split("\n").filter((l) => l.startsWith("f") && !l.startsWith("..."));
    expect(files.length).toBe(500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
