# coderig

终端编码助手 —— 一个学习用的 mini agent harness:终端 CLI + 工具系统 + 可观测性。

它不是功能最全的 harness,而是一个"自己实现一遍 Claude Code 核心机制"的练习场:agent loop、工具调用、上下文压缩、权限门、网络韧性、观测 trace,每一层的设计取舍都写在代码注释里。

## 安装

```bash
npm install -g coderig
```

全局安装后在任意项目目录里直接运行:

```bash
cd your-project
coderig
```

首次运行会引导你填入 DeepSeek API key(模型固定 `deepseek-v4-flash`,后端只支持 DeepSeek),写入 `~/.coderig/config.json`。

## 用法

```
coderig                      在当前目录开始新对话
coderig --resume <cid>       续话指定对话
coderig --list               列出历史对话
coderig --snapshots [cid]    列出改动快照(模型改坏文件后靠它找回原内容)
coderig --restore <cid> <path>  恢复该文件的快照内容(覆盖前确认)
coderig config               重新跑配置向导
coderig --version            版本号
coderig --help               显示帮助
```

它能做的:读取/搜索/修改当前目录的代码、运行 shell 命令(危险命令会先问你)、记住跨会话的对话历史并检索、复杂任务先拆解规划(todo)、进入规划模式(enter_plan_mode)只读调研并提交计划审批后再实施、每次改动前自动留底快照(改错可 `--restore` 恢复)。

## 配置

配置文件:`~/.coderig/config.json`(权限 0600,明文 API key 不会被别人读到)。

环境变量优先级高于配置文件,方便临时切换:

| 变量 | 说明 |
|---|---|
| `API_KEY` / `MODEL` / `BASE_URL` / `ENDPOINT` | 覆盖 provider 配置 |
| `CONTEXT_WINDOW_TOKENS` | 上下文窗口预算,默认 1M |
| `MAX_OUTPUT_TOKENS` | 单次输出上限,默认 32768 |
| `CODERIG_HOME` | 状态目录,默认 `~/.coderig/` |
| `PROMPT_VERSION` | 设 `none` 跑无系统提示词基线 |

运行时状态(trace 观测、对话转录)都在 `~/.coderig/` 下,**不会写进你的项目目录**。

## 架构

```
index.ts                    CLI 入口
src/
├── cli/chat.ts             agent loop(判停、工具执行、权限门、压缩触发)
├── llm/                    LLM 客户端(SSE 流式、重试、DeepSeek thinking 协议)
├── tools/                  工具系统(read/write/edit/bash/grep/glob + 权限门)
├── history/                上下文管理(无损转录 + 有损发送视图 + 摘要压缩)
├── config/                 配置层(env > 文件 > 向导)与路径收敛
├── prompts/system.ts       系统提示词(带版本历史)
└── observability/tracer.ts 观测(trace.jsonl,跨运行累积)
```

设计细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 开发

```bash
bun install
bun run index.ts          # 从源码跑
bun test                  # 单测
bunx tsc --noEmit         # 类型检查
bun run build             # 编译全平台二进制到 dist/
```
