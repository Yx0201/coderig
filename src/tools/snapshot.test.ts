import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SnapshotStore } from "./snapshot.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "coderig-test-"));
}

test("snapshot:留底原内容 + meta 清单,restore 能恢复", async () => {
  const dir = makeTmp();
  try {
    const snapDir = join(dir, "snaps");
    const file = join(dir, "a.ts");
    await Bun.write(file, "original content");
    const store = new SnapshotStore(snapDir, "sess-1");

    const meta = await store.snapshot(file);
    expect(meta).not.toBeNull();
    expect(meta!.path).toBe(file);

    // 原文件被改坏后,restore 找回原始内容
    await Bun.write(file, "changed by model");
    const r = await store.restore("sess-1", file);
    expect(r.ok).toBe(true);
    expect(await Bun.file(file).text()).toBe("original content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot:新建文件(不存在)不落底", async () => {
  const dir = makeTmp();
  try {
    const store = new SnapshotStore(join(dir, "snaps"), "s");
    const meta = await store.snapshot(join(dir, "not-exist.ts"));
    expect(meta).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot:同路径保留首版(评审 P1-1),恢复回到最初内容", async () => {
  const dir = makeTmp();
  try {
    const snapDir = join(dir, "snaps");
    const file = join(dir, "a.ts");
    const store = new SnapshotStore(snapDir, "s");
    await Bun.write(file, "v1");
    await store.snapshot(file); // 首版快照 = v1
    await Bun.write(file, "v2");
    await store.snapshot(file); // 已有首版,跳过不覆盖(P1-1:"回滚"要会话开始前的状态)
    const metas = await store.listForScope("s");
    expect(metas.length).toBe(1);
    expect(metas[0]!.path).toBe(file);
    // 恢复回的是最初的 v1,而不是第二次写前的中间态 v2
    await Bun.write(file, "scrambled");
    await store.restore("s", file);
    expect(await Bun.file(file).text()).toBe("v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore:没有该路径快照 → 错误", async () => {
  const dir = makeTmp();
  try {
    const store = new SnapshotStore(join(dir, "snaps"), "s");
    const r = await store.restore("s", join(dir, "never.ts"));
    expect(r.ok).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listScopes:多个会话各自分组", async () => {
  const dir = makeTmp();
  try {
    const snapDir = join(dir, "snaps");
    const file = join(dir, "a.ts");
    await Bun.write(file, "x");
    const s1 = new SnapshotStore(snapDir, "sess-a");
    const s2 = new SnapshotStore(snapDir, "sess-b");
    await s1.snapshot(file);
    await s2.snapshot(file);
    const scopes = await s1.listScopes();
    expect(scopes.sort()).toEqual(["sess-a", "sess-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
