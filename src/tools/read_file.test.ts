import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFileHandler } from "./read_file.ts";
import { createSessionContext } from "./context.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

test("read_file:空读(offset 越界)不记指纹,不绕过 read-before-write 门(评审 P1-7)", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "line1\nline2\n");
    const ctx = createSessionContext({});
    const r = await readFileHandler({ path: file, offset: 9999 }, ctx);
    expect(r).toContain("错误"); // 空读:没看到任何内容
    const abs = resolve(file);
    expect(ctx.readPaths.has(abs)).toBe(false); // 不算读过
    expect(ctx.fileStates.has(abs)).toBe(false); // 不记指纹
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file:正常读到内容才记指纹", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "line1\nline2\n");
    const ctx = createSessionContext({});
    const r = await readFileHandler({ path: file }, ctx);
    expect(r.startsWith("错误")).toBe(false);
    const abs = resolve(file);
    expect(ctx.readPaths.has(abs)).toBe(true);
    expect(ctx.fileStates.get(abs)!.hash).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
