import { resolve } from "node:path";
import type { ToolDef, ToolHandler } from "../llm/types.ts";
import { sha256 } from "./snapshot.ts";

export const writeFileDef: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "创建新文件,或整体覆写已有文件的全部内容。适用:新建文件、确认要全量替换某文件时。" +
      "不适用:对已有文件做局部小改动(用 edit_file,更省 token 也更安全)。" +
      "覆写已存在文件前,必须先 read_file 读一次(harness 强制);文件在读取后被外部改过会被拒绝,需重读。" +
      "内容会被完整写入,旧内容完全替换——不要用占位符(如 // ... 其余代码),要写就写全。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径，相对当前工作目录或绝对路径",
        },
        content: {
          type: "string",
          description: "要写入文件的完整内容",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

export const writeFileHandler: ToolHandler = async (args, ctx) => {
  const path = args?.path;
  const content = args?.content;
  if (!path) return "错误：缺少 path 参数";
  if (content === undefined || content === null)
    return "错误：缺少 content 参数";

  const abs = resolve(path);
  const exists = await Bun.file(abs).exists();

  // 覆写已存在文件:过 read-before-write + 冲突检测门(harness 兜底,防基于过期内容覆盖)。
  // 新建文件无原内容,免检
  if (exists) {
    if (!ctx.readPaths.has(abs)) {
      ctx.gate({ kind: "read_before_write", path });
      return "错误：覆写已存在的文件前必须先 read_file 读取当前内容,确认后再决定是否全量覆盖";
    }
    const current = await Bun.file(abs).text();
    const known = ctx.fileStates.get(abs);
    if (known && known.hash !== sha256(current)) {
      ctx.gate({ kind: "conflict", path });
      return "错误：文件自上次读取后已被修改(可能被外部或其它工具改动),请重新 read_file 再决定怎么覆盖";
    }
  }

  try {
    // 写前快照:给"改错了可回滚"留底(新建文件无原内容,store 内部会跳过)
    await ctx.snapshot(path);
    // Bun.write 自动创建缺失的父目录(与 mkdir recursive + writeFile 两步等价),
    // 新建嵌套路径文件一步到位
    await Bun.write(abs, content);
    // 写成功 = 会话现在知道这份新内容,更新指纹,避免"编辑后再编辑"被误判冲突
    ctx.fileStates.set(abs, { hash: sha256(content) });
    ctx.readPaths.add(abs);
    return `已写入 ${path} (${content.length} 字符)`;
  } catch (e) {
    return `错误：写入文件失败 ${e instanceof Error ? e.message : String(e)}`;
  }
};

// mutates:写文件改外部状态,不能与其它写并行(见 registry.ts)
export const writeFileTool = {
  def: writeFileDef,
  handler: writeFileHandler,
  mutates: true,
};
