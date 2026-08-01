import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { editFileHandler } from "./edit_file.ts";
import { createSessionContext } from "./context.ts";
import { sha256 } from "./snapshot.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

test("read-before-write 门:没读过就编辑 → 拦截", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "const a = 1;\n");
    const ctx = createSessionContext({});
    let gated = 0;
    ctx.gate = () => gated++;
    const r = await editFileHandler(
      { path: file, oldString: "a", newString: "b" },
      ctx,
    );
    expect(r).toContain("必须先 read_file");
    expect(gated).toBe(1); // 观测钩子被触发
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("冲突检测:读后文件被外部改过 → 拦截", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "on-disk content");
    const abs = resolve(file);
    const ctx = createSessionContext({});
    ctx.readPaths.add(abs);
    ctx.fileStates.set(abs, { hash: sha256("stale content") }); // 会话读到的是旧内容
    const r = await editFileHandler(
      { path: file, oldString: "content", newString: "changed" },
      ctx,
    );
    expect(r).toContain("已被修改");
    // 文件未被改动
    expect(await Bun.file(file).text()).toBe("on-disk content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("编辑成功:两种模式都行,且写后指纹更新(连续编辑不误判冲突)", async () => {
  const dir = makeTmp();
  try {
    const file = join(dir, "a.ts");
    await Bun.write(file, "const a = 1;\nconst b = 2;\n");
    const abs = resolve(file);
    const ctx = createSessionContext({});
    ctx.readPaths.add(abs);
    ctx.fileStates.set(abs, { hash: sha256("const a = 1;\nconst b = 2;\n") });

    // 模式1:oldString 唯一替换
    const r1 = await editFileHandler(
      { path: file, oldString: "const a = 1;", newString: "const a = 10;" },
      ctx,
    );
    expect(r1.startsWith("错误")).toBe(false);
    // 写后指纹更新到新内容
    expect(ctx.fileStates.get(abs)!.hash).toBe(sha256("const a = 10;\nconst b = 2;\n"));

    // 模式2:行号区间替换 —— 基于上次编辑后更新的指纹,不应误判冲突
    const r2 = await editFileHandler(
      { path: file, start_line: 2, end_line: 2, newString: "const b = 20;" },
      ctx,
    );
    expect(r2.startsWith("错误")).toBe(false);
    expect(await Bun.file(file).text()).toBe("const a = 10;\nconst b = 20;\n");
    expect(ctx.fileStates.get(abs)!.hash).toBe(sha256("const a = 10;\nconst b = 20;\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
