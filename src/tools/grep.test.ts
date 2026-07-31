import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grepHandler } from "./grep.ts";
import { createSessionContext } from "./context.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

const ctx = createSessionContext({}); // grep 不碰 ctx,传空即可满足签名

test("grep:基础字面量匹配", async () => {
  const dir = makeTmp();
  try {
    await Bun.write(join(dir, "a.ts"), "const foo = 1;\nconst bar = 2;\n");
    const r = await grepHandler({ pattern: "foo", path: dir }, ctx);
    expect(r).toContain("a.ts");
    expect(r).toContain("foo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:contextLines 带出上下文行,命中行与上下文行区分", async () => {
  const dir = makeTmp();
  try {
    await Bun.write(join(dir, "a.ts"), "line1\nline2\nHIT\nline4\nline5\n");
    const r = await grepHandler({ pattern: "HIT", path: dir, contextLines: 1 }, ctx);
    expect(r).toContain("· 2: line2"); // 上下文行 · 前缀
    expect(r).toContain("· 4: line4");
    expect(r).toContain("  3: HIT"); // 命中行空格前缀
    expect(r).not.toContain("line1"); // contextLines=1 不带更远
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:超长行截断到 200 字符并带省略标记", async () => {
  const dir = makeTmp();
  try {
    await Bun.write(join(dir, "a.ts"), "x".repeat(500) + "\n");
    const r = await grepHandler({ pattern: "xxx", path: dir }, ctx);
    expect(r).toContain("…");
    // 结果行 = "  1: " + 200 字符 + "…"
    const hit = r.split("\n").find((l) => l.includes("…"));
    expect(hit!.length).toBe("  1: ".length + 201);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:isRegex 开关生效", async () => {
  const dir = makeTmp();
  try {
    await Bun.write(join(dir, "a.ts"), "foo123\nfoo456\nbar\n");
    const r = await grepHandler({ pattern: "^foo\\d+", path: dir, isRegex: true }, ctx);
    expect(r).toContain("foo123");
    expect(r).toContain("foo456");
    expect(r).not.toContain("bar");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:命中文件数超过上限截断并提示", async () => {
  const dir = makeTmp();
  try {
    await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        Bun.write(join(dir, `f${i}.ts`), `needle ${i}\n`),
      ),
    );
    const r = await grepHandler({ pattern: "needle", path: dir }, ctx);
    expect(r).toContain("结果过多");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:.gitignore/.github 等带点文件可被搜到(评审 P0-3,修复前被 .git/CVS 子串误伤)", async () => {
  const dir = makeTmp();
  try {
    await Promise.all([
      Bun.write(join(dir, "src", "a.ts"), "needle\n"),
      Bun.write(join(dir, ".gitignore"), "needle\n"),
      Bun.write(join(dir, ".github", "ci.yml"), "needle\n"),
      Bun.write(join(dir, "myCVSnotes.md"), "needle\n"),
    ]);
    const r = await grepHandler({ pattern: "needle", path: dir }, ctx);
    expect(r).toContain("a.ts");
    expect(r).toContain(".gitignore"); // 修复前被 ".git" 子串过滤掉
    expect(r).toContain("ci.yml"); // .github 不再被忽略
    expect(r).toContain("myCVSnotes.md"); // CVS 不再误伤
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep:contextLines 传非数字不崩溃、不吞命中(评审 P1-3)", async () => {
  const dir = makeTmp();
  try {
    await Bun.write(join(dir, "a.ts"), "line1\nHIT\nline3\n");
    // 修复前 Math.floor("abc") = NaN → start/end NaN → 命中行整个消失
    const r = await grepHandler({ pattern: "HIT", path: dir, contextLines: "abc" }, ctx);
    expect(r).toContain("HIT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
