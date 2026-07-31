import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileHandler } from "./write_file.ts";
import { createSessionContext } from "./context.ts";
import { sha256 } from "./snapshot.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

test("新建文件:免 read-before-write 门", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "new.ts");
    const ctx = createSessionContext({});
    const r = await writeFileHandler({ path: file, content: "hello" }, ctx);
    expect(r.startsWith("错误")).toBe(false);
    expect(await Bun.file(file).text()).toBe("hello");
    // 写后也记录指纹,后续编辑不误判
    expect(ctx.fileStates.has(resolve(file))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆写已存在文件:没读过 → read-before-write 拦截", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "old");
    const ctx = createSessionContext({});
    const r = await writeFileHandler({ path: file, content: "new" }, ctx);
    expect(r).toContain("必须先 read_file");
    expect(await Bun.file(file).text()).toBe("old"); // 未写入
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆写已存在文件:读后内容一致 → 成功", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "old content");
    const abs = resolve(file);
    const ctx = createSessionContext({});
    ctx.readPaths.add(abs);
    ctx.fileStates.set(abs, { hash: sha256("old content") });
    const r = await writeFileHandler({ path: file, content: "brand new" }, ctx);
    expect(r.startsWith("错误")).toBe(false);
    expect(await Bun.file(file).text()).toBe("brand new");
    expect(ctx.fileStates.get(abs)!.hash).toBe(sha256("brand new"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("覆写已存在文件:读后内容被改 → 冲突拦截", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "external changed it");
    const abs = resolve(file);
    const ctx = createSessionContext({});
    ctx.readPaths.add(abs);
    ctx.fileStates.set(abs, { hash: sha256("what model read") });
    const r = await writeFileHandler({ path: file, content: "overwrite" }, ctx);
    expect(r).toContain("已被修改");
    expect(await Bun.file(file).text()).toBe("external changed it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
