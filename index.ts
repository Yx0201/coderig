import { startChat } from "./src/cli/chat.ts";
import { setupTools } from "./src/tools/index.ts";
import { History } from "./src/history/store.ts";

// v1 的 CLI 入口:只给三个用法,不引入命令解析库
//   bun index.ts                → 新开一段对话
//   bun index.ts --list         → 列出所有历史对话
//   bun index.ts --resume <cid> → 续话指定对话
const [, , ...args] = process.argv;

if (args[0] === "--list") {
  const list = await History.list();
  if (list.length === 0) {
    console.log("(暂无历史对话)");
  } else {
    // 简单表格输出:cid / 预览 / 消息数 / 模型 / 提示词版本
    for (const h of list) {
      const when = new Date(h.createdAt).toISOString().slice(0, 19).replace("T", " ");
      console.log(
        `${h.cid}  [${h.promptVersion}/${h.model}]  ${h.count}条  ${when}\n  → ${h.preview}`,
      );
    }
  }
} else {
  const resumeIdx = args.indexOf("--resume");
  const resumeCid = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
  setupTools();
  try {
    await startChat(resumeCid);
  } catch (err) {
    // 续话 cid 不存在等明确错误:干净地报一行退出,而不是甩一屏堆栈
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
