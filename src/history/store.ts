import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../llm/types.ts";

// history 与 tracer 是两套独立持久化:
// - trace.jsonl 记"观测事件"(按 sid 切一次运行),诊断用、会截断;
// - logs/history/<cid>.jsonl 记"发给模型的对话转录本身"(一个对话一个文件),完整不截断。
// 续话时原样把消息灌回内存当上下文,所以落盘的必须是我们真正发给模型的东西。

const HISTORY_DIR = "logs/history";

// 对话元数据头:写在每个文件第一行,关联到 trace 的 sid 用
export interface HistoryMeta {
  v: 1; // 格式版本,以后格式演进靠它判旧文件
  kind: "meta";
  cid: string; // 对话 id,同时是文件名
  createdAt: number; // 创建时间戳,用于 list 排序
  model: string; // 当时用的模型
  promptVersion: string; // 当时的提示词版本,换 sysprompt 续话也能看出来
}

// 消息行:meta 头之外,每行一条。字段就是 ChatMessage 加个 kind 标记
export type HistoryLine =
  | HistoryMeta
  | ({ kind: "msg" } & ChatMessage);

export class History {
  readonly cid: string;
  private msgs: ChatMessage[] = [];
  private readonly path: string;
  // 写盘队列:appendFile 异步,事件密集时并发写会乱序,
  // 用 promise 链串起来,保证文件行序 = append 调用序(与 tracer 同理)
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(cid: string) {
    this.cid = cid;
    this.path = join(HISTORY_DIR, `${cid}.jsonl`);
  }

  // 新开对话:生成 cid(ISO 时间戳,与 tracer 的 sid 同格式,人眼可比对),写 meta 头
  static create(meta: { model: string; promptVersion: string }): History {
    const cid = new Date().toISOString().replace(/[:.]/g, "-");
    const h = new History(cid);
    h.appendLine({ v: 1, kind: "meta", cid, createdAt: Date.now(), ...meta });
    return h;
  }

  // 续话:读已有文件,把 meta 头之外的消息行灌回内存数组
  // 文件不存在直接抛——续话传错 cid 应该明确失败,而不是静默开新对话
  static async load(cid: string): Promise<History> {
    const h = new History(cid);
    if (!existsSync(h.path)) {
      throw new Error(`对话不存在: ${cid}`);
    }
    const raw = await readFile(h.path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let obj: HistoryLine;
      try {
        obj = JSON.parse(line) as HistoryLine;
      } catch {
        // 单行解析失败不致命:跳过坏行,保住已落盘的好消息
        continue;
      }
      if (obj.kind === "msg") {
        const { kind: _kind, ...msg } = obj;
        h.msgs.push(msg);
      }
      // meta 头不需要灌进 msgs,它只是元信息
    }
    return h;
  }

  // 列出所有历史对话:扫目录,读每个文件取 meta 头 + 首条 user 预览 + 消息数
  // 返回按创建时间倒序(新的在前),给 --list 打表用
  static async list(): Promise<{
    cid: string;
    preview: string; // 首条 user 消息的前若干字
    count: number; // 消息条数(不含 meta)
    createdAt: number;
    model: string;
    promptVersion: string;
  }[]> {
    if (!existsSync(HISTORY_DIR)) return [];
    const files = (await readdir(HISTORY_DIR)).filter((f) =>
      f.endsWith(".jsonl"),
    );
    const out: any[] = [];
    for (const f of files) {
      const cid = f.replace(/\.jsonl$/, "");
      let meta: HistoryMeta | null = null;
      let firstUser = "";
      let count = 0;
      try {
        const raw = await readFile(join(HISTORY_DIR, f), "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const obj = JSON.parse(line) as HistoryLine;
          if (obj.kind === "meta" && !meta) meta = obj;
          else if (obj.kind === "msg") {
            count++;
            if (obj.role === "user" && !firstUser) {
              firstUser = (obj.content ?? "").slice(0, 40);
            }
          }
        }
      } catch {
        continue; // 坏文件跳过,不让 list 整个崩
      }
      if (meta) {
        out.push({
          cid,
          preview: firstUser || "(无用户输入)",
          count,
          createdAt: meta.createdAt,
          model: meta.model,
          promptVersion: meta.promptVersion,
        });
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  // 暴露只读视图:chat.ts 把它传给 sendMessages,自己不能改它(防止绕过 append 漏落盘)
  get messages(): readonly ChatMessage[] {
    return this.msgs;
  }

  // chat.ts 里所有 history = [...history, x] 都改成调这个:
  // 内存加一条 + 同步落盘一条,一步完成,不存在"内存有文件没有"的漂移
  append(msg: ChatMessage): void {
    this.msgs.push(msg);
    this.appendLine({ kind: "msg", ...msg } as HistoryLine);
  }

  // 内部:把一行 JSON 追加进文件。串行写盘保行序,落盘失败不抛(观测/转录层不能搞崩主流程)
  private appendLine(line: HistoryLine): void {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(HISTORY_DIR, { recursive: true });
        await appendFile(this.path, JSON.stringify(line) + "\n", "utf8");
      } catch {
        // 落盘失败静默吞掉:宁可漏记也不能让对话流程因写盘出错而中断
      }
    });
  }
}
