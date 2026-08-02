import pkg from "./package.json" with { type: "json" };
import { startChat } from "./src/cli/chat.ts";
import { setupTools } from "./src/tools/index.ts";
import { History } from "./src/history/store.ts";
import { loadConfig, setConfig } from "./src/config/index.ts";
import { runSetup } from "./src/cli/setup.ts";
import { listSnapshotsCmd, restoreCmd } from "./src/cli/snapshot_cmd.ts";

// coderig:终端编码助手
//
// 用法:
//   coderig                    在当前目录开始新对话
//   coderig --resume <cid>     续话指定对话
//   coderig --list             列出历史对话
//   coderig --snapshots [cid]  列出改动快照(可加会话 id)
//   coderig --restore <cid> <path>  恢复该文件的快照内容(覆盖前确认)
//   coderig config             重新跑配置向导
//   coderig --version          版本号
//   coderig --help             显示帮助

// 版本号从 package.json 读(编译时被 Bun 内联进二进制),发布改版本只需改 package.json
const VERSION = pkg.version;

const [, , ...args] = process.argv;

function showHelp() {
  console.log(`coderig v${VERSION} — 终端编码助手

用法:
  coderig                      在当前目录开始新对话
  coderig --resume <cid>       续话指定对话
  coderig --list               列出历史对话
  coderig --snapshots [cid]    列出改动快照(可加会话 id)
  coderig --restore <cid> <path>  恢复该文件的快照内容(覆盖前确认)
  coderig config               重新跑配置向导
  coderig --version            版本号
  coderig --help               显示帮助

配置: 首次运行自动引导,或手动编辑 ~/.coderig/config.json
`);
}

async function main() {
  // 帮助和版本不需要配置
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  // 配置向导(显式触发,或首次运行自动触发)
  if (args[0] === "config") {
    const cfg = await runSetup();
    setConfig(cfg);
    console.log("配置完成,现在可以运行 coderig 开始对话");
    return;
  }

  // 列出历史对话不需要 LLM 配置
  if (args[0] === "--list") {
    const list = await History.list();
    if (list.length === 0) {
      console.log("(暂无历史对话)");
    } else {
      for (const h of list) {
        const when = new Date(h.createdAt)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        console.log(
          `${h.cid}  [${h.promptVersion}/${h.model}]  ${h.count}条  ${when}\n  → ${h.preview}`,
        );
      }
    }
    return;
  }

  // 快照:列出/恢复不需要 LLM 配置(改动快照给"模型改错文件"留底)
  if (args[0] === "--snapshots") {
    await listSnapshotsCmd(args[1]);
    return;
  }
  if (args[0] === "--restore") {
    const cid = args[1];
    const path = args[2];
    if (!cid || !path) {
      console.log("用法:coderig --restore <cid> <path>");
      return;
    }
    await restoreCmd(cid, path);
    return;
  }

  // 主流程:加载配置 → 注入 → 启动对话
  let cfg = await loadConfig();
  if (!cfg) {
    // 首次运行或配置不完整,跑向导
    cfg = await runSetup();
  }
  setConfig(cfg);

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

main();
