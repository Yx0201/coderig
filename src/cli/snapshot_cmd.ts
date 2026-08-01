// ===== 快照 CLI:--snapshots / --restore =====
//
// 改动快照(见 tools/snapshot.ts)给"模型改错文件"留了底,这里把"看底/恢复"暴露给用户:
//   coderig --snapshots             按会话分组列出所有快照
//   coderig --snapshots <cid>       列出某个会话的快照
//   coderig --restore <cid> <path>  把该会话里 path 的最新快照恢复回去(覆盖前弹确认)
// 不需要 LLM 配置,路由在 index.ts 主流程之前。

import pc from "picocolors";
import * as p from "@clack/prompts";
import { SnapshotStore, type SnapshotMeta } from "../tools/snapshot.ts";
import { snapshotDir } from "../config/paths.ts";

function printMeta(m: SnapshotMeta) {
  const when = new Date(m.ts).toISOString().slice(0, 19).replace("T", " ");
  console.log(`  ${m.path} · ${m.size} 字符 · ${when}`);
}

// --snapshots [cid]:不带 cid 按会话分组列出;带 cid 只列该会话
export async function listSnapshotsCmd(cid?: string): Promise<void> {
  const store = new SnapshotStore(snapshotDir(), cid ?? "");
  if (cid) {
    const metas = await store.listForScope(cid);
    if (metas.length === 0) {
      console.log(`(会话 ${cid} 暂无快照)`);
      return;
    }
    console.log(`会话 ${cid} 的快照:`);
    for (const m of metas) printMeta(m);
    return;
  }
  const scopes = await store.listScopes();
  if (scopes.length === 0) {
    console.log("(暂无快照,运行对话并让模型改过文件后会有)");
    return;
  }
  for (const s of scopes) {
    const metas = await store.listForScope(s);
    if (metas.length === 0) continue;
    console.log(`会话 ${s}(${metas.length} 个文件):`);
    for (const m of metas) printMeta(m);
  }
}

// --restore <cid> <path>:恢复该文件到该会话的最新快照内容(覆盖当前文件,先确认)
export async function restoreCmd(cid: string, path: string): Promise<void> {
  const store = new SnapshotStore(snapshotDir(), cid);
  const confirm = await p.confirm({
    message: `从会话 ${cid} 恢复 ${path}?这会覆盖文件当前内容`,
  });
  if (p.isCancel(confirm) || !confirm) {
    console.log("已取消");
    return;
  }
  const r = await store.restore(cid, path);
  if (r.ok) console.log(`已恢复 ${r.path} 到快照时的内容`);
  else console.log(pc.red(r.error));
}
