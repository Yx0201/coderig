// ===== 状态目录惰性 GC(评审 P1-10)=====
//
// tmp/(bash 大输出落盘)与 snapshots/(改动快照)只写不删,~/.coderig/ 会无限增长,
// 而且快照里是用户源码的历史副本,留着是隐私面。startChat 开头 fire-and-forget 调一次:
//   - tmp/ 删 mtime 超过 24h 的文件
//   - snapshots/ 只保留最近 N 个会话目录(会话名是 ISO 时间戳,字典序≈时间序)
// 全部静默:GC 失败不能影响对话启动。

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpDir, snapshotDir } from "../config/paths.ts";

const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const SNAPSHOT_MAX_CIDS = 20;

export async function gcStateDir(): Promise<void> {
  try {
    // tmp/:删过期文件
    const tmp = tmpDir();
    const tmpFiles = await readdir(tmp).catch(() => [] as string[]);
    for (const f of tmpFiles) {
      try {
        const s = await stat(join(tmp, f));
        if (s.isFile() && Date.now() - s.mtimeMs > TMP_MAX_AGE_MS)
          await rm(join(tmp, f), { force: true });
      } catch {
        // 单个文件 stat/删失败跳过,不影响其它
      }
    }

    // snapshots/:保留最近 N 个会话目录
    const snaps = snapshotDir();
    const scopes = (await readdir(snaps).catch(() => [] as string[])).filter(
      (f) => !f.startsWith("."),
    );
    scopes.sort().reverse(); // 会话名是时间戳,字典序倒排 = 最新的在前
    for (const old of scopes.slice(SNAPSHOT_MAX_CIDS)) {
      await rm(join(snaps, old), { recursive: true, force: true });
    }
  } catch {
    // GC 失败不能影响对话启动,静默吞
  }
}
