// ===== 改动快照:mutating 工具写前留底 =====
//
// 权限门回答"该不该做",快照回答"做错了怎么办"。write_file/edit_file 在真正
// 覆写前,把原内容落到 snapshotDir()/<会话>/<sha(绝对路径)>.prev,并写一份
// <sha>.meta.json 清单(映射 hash→原路径,供恢复与列表用)。同路径覆盖保留最新,
// 历史版本不保留(轻量级,不做版本树)。
//
// 会话分组用 cid(对话 id):续话时同一个 cid 多次运行共享快照,恢复时也按 cid 找。
// 路径哈希用绝对路径的 sha256 —— 快照文件名不暴露用户路径,且跨项目也不会碰撞。
//
// 不做 bash 的快照:bash 改了哪些文件无法精确预知,靠权限门挡;快照只覆盖
// 确定性的文件写工具。恢复是"用户主动"的动作(CLI --restore),不做成模型工具。

import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";

// 一条快照的元数据:原路径/时间/大小。文件叫 <sha>.meta.json,内容一行 JSON
export interface SnapshotMeta {
  path: string; // 原始绝对路径
  ts: number; // 留底时间(ms)
  size: number; // 原内容字符数
}

export function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export class SnapshotStore {
  // dir: 快照根目录(snapshotDir());scope: 会话分组(cid)
  constructor(
    private dir: string,
    private scope: string,
  ) {}

  private basePath(absPath: string): string {
    return join(this.dir, this.scope, sha256(absPath));
  }

  // 写前快照:文件不存在(新建)无原内容可留,跳过;
  // 否则把原内容 + meta 落盘。Bun.write 自动建父目录。
  // 同路径只保留首版(评审 P1-1):"回滚"要的是会话开始前的状态,
  // 连写两次时第二次写前的中间态不该覆盖最初的原始版本
  async snapshot(path: string): Promise<SnapshotMeta | null> {
    const abs = resolve(path); // 与写工具的路径解析一致(相对 cwd / 绝对路径原样)
    const file = Bun.file(abs);
    if (!(await file.exists())) return null; // 新建文件,无原内容
    const base = this.basePath(abs);
    if (await Bun.file(`${base}.prev`).exists()) return null; // 首版已在,不覆盖
    const content = await file.text();
    await Bun.write(`${base}.prev`, content);
    const meta: SnapshotMeta = { path: abs, ts: Date.now(), size: content.length };
    await Bun.write(`${base}.meta.json`, JSON.stringify(meta) + "\n");
    return meta;
  }

  // 列出某个会话的快照(按 meta 里的原路径去重,保留最新一份)
  async listForScope(scope: string): Promise<SnapshotMeta[]> {
    const dir = join(this.dir, scope);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return []; // 目录不存在(该会话无快照)
    }
    const metas: SnapshotMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(
          await Bun.file(join(dir, f)).text(),
        ) as SnapshotMeta;
        metas.push(meta);
      } catch {
        continue; // 单个 meta 损坏跳过,不影响其它
      }
    }
    // 同路径覆盖保留最新:倒序后按 path 去重
    metas.sort((a, b) => b.ts - a.ts);
    return [...new Map(metas.map((m) => [m.path, m])).values()];
  }

  // 列出所有有快照的会话
  async listScopes(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  }

  // 恢复:找到该会话里 path 的快照,把原内容写回。
  // 覆盖前由 CLI 弹确认,这里只负责找 + 写;任何异常都返回错误而不抛出(评审 P1-9)
  async restore(scope: string, path: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    try {
      const abs = resolve(path);
      const base = join(this.dir, scope, sha256(abs));
      const metaFile = Bun.file(`${base}.meta.json`);
      if (!(await metaFile.exists()))
        return { ok: false, error: `会话 ${scope} 里没有 ${path} 的快照(可能从未被写过或已覆盖清理)` };
      // meta 里的 path 与请求的一致才恢复,防止 hash 碰撞/路径错位
      const meta = JSON.parse(await metaFile.text()) as SnapshotMeta;
      if (meta.path !== abs)
        return { ok: false, error: `快照路径不匹配:期望 ${meta.path},收到 ${abs}` };
      const prevFile = Bun.file(`${base}.prev`);
      if (!(await prevFile.exists()))
        return { ok: false, error: `快照内容文件缺失(meta 在但 .prev 不在,可能被清理或写盘中断)` };
      const content = await prevFile.text();
      await Bun.write(abs, content);
      return { ok: true, path: abs };
    } catch (e) {
      return { ok: false, error: `恢复失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
