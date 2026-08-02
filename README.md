# coderig

**兼容 DeepSeek API 的终端编程 harness —— 从零实现的 Claude Code 式 agent 系统。**

`coderig` 是一个运行在终端里的自主编码助手:它读取/搜索/修改你的代码、运行 shell 命令、拆解复杂任务、规划审批后实施,并能在模型把文件改坏时恢复原样。它不是对现成 agent 框架的封装,而是把 agent 系统的每一层——agent loop、工具调用、权限门、上下文管理、可观测性——从零写了一遍,并且每一层都针对 DeepSeek 的协议特性(thinking 模式、`reasoning_content` 回传、上下文缓存)做过专门设计,目标是把模型能力压榨干净。

已发布到 npm(`coderig`),`bun build --compile` 产出全平台单文件二进制,装成全局命令后可以在任意项目目录里直接用。

- TypeScript · Bun · 零运行时依赖(单二进制分发,不依赖 Node)
- 开源地址: [github.com/Yx0201/coderig](https://github.com/Yx0201/coderig)
- English: [README.en.md](README.en.md)

---

## 亮点速览

| 层 | 做了什么 | 面试官会问的点 |
|---|---|---|
| **Agent Loop** | 判停、兜底、收尾轮、死循环检测 | "无 tool_calls"判停 + `finish_reason` 兜底;超限/死循环时禁工具让模型总结,而非硬停 |
| **DeepSeek 适配** | thinking 协议、缓存友好、网络韧性 | 带 `tool_calls` 的 assistant 消息必须原样回传 `reasoning_content`(协议硬约束);运行时状态放消息尾部不污染前缀,保缓存命中 |
| **工具系统** | 11 个工具 + 注册表 + 两阶段执行 | `def` + `handler` 约定;并行波次 + 文件锁冲突检测;read-before-write 护栏 |
| **权限安全** | 三级权限门 + 危险命令识别 | auto/ask/deny;`rm -rf`/`sudo`/`git push --force`/`curl \| sh` 不可会话放行;只读白名单带逃逸口子检测 |
| **上下文管理** | 1M 窗口 + LLM 摘要压缩 | 无损转录与有损发送视图分离;用真实 `prompt_tokens` 触发压缩;CJK 感知 token 估算 |
| **可观测性** | 16 种事件类型、跨运行 trace | `sid`/`seq`/`round`/`ts` 四维索引;原始 SSE 报文落盘,诊断 thinking 协议;每次授权决策记 `approval` 事件 |
| **双渲染后端** | 线性(Clack)+ TUI(Ink + React) | 同一套 `chat.ts` 驱动两种终端 UI;TUI 用 `useSyncExternalStore` 订阅,回卷 + live 流式区 + 模态交互 |

规模:~8.5k 行 TypeScript,**29 个单测文件**覆盖判停、权限、压缩、死循环检测、双渲染等核心逻辑。

---

## 安装与使用

```bash
npm install -g coderig
cd your-project
coderig
```

首次运行引导填入 DeepSeek API key,写入 `~/.coderig/config.json`(权限 0600)。

```
coderig                      在当前目录开始新对话
coderig --resume <cid>       续话指定对话(转录跨会话持久化)
coderig --list               列出历史对话
coderig --snapshots [cid]    列出改动快照(模型改坏文件后靠它找回原内容)
coderig --restore <cid> <path>  恢复该文件的快照内容(覆盖前确认)
coderig config               重新跑配置向导
```

它能做的:

- 读取/搜索/修改当前目录的代码,运行 shell 命令(危险命令先问你)
- 复杂任务先拆解成 `todo` 清单逐项勾选
- 进入**规划模式**只读调研,把计划写入独立目录、提交审批后才动手实施
- 每次改动前自动留底**快照**,改错了 `--restore` 恢复
- 跨会话续话:同一段对话共享快照与 todo 状态

配置:`~/.coderig/config.json`,环境变量优先级更高(`API_KEY` / `MODEL` / `BASE_URL` / `CONTEXT_WINDOW_TOKENS` / `MAX_OUTPUT_TOKENS` / `CODERIG_HOME`…)。所有运行时状态都在 `~/.coderig/` 下,**不会写进你的项目目录**。

---

## 核心机制

### 1. Agent Loop —— 判停与兜底

核心循环:模型产出 → 有 `tool_calls` 就执行工具回填 → 再问一轮 → 无 `tool_calls` 即视为最终回答,停止。每一层异常都有明确兜底,而不是把烂摊子甩给用户:

- **判停语义**:不解析 `[DONE]`(传输层 EOF ≠ 回答完成),以"本轮无 tool_calls"为停止信号,`finish_reason` 只作兜底校验
- **收尾轮**:达到 50 轮上限或检测到死循环时,**禁用工具**再发最后一轮,让模型用纯文本交代"完成了什么/剩什么/建议下一步"——信息价值远高于硬停
- **nudge 机制**:模型空回答(无内容也无工具调用)时注入续轮提示,最多 2 次;再不答才放弃,不会无限续轮
- **死循环检测**:对调用序列做模式匹配,识别"重复调用同一工具同一参数"的振荡
- **请求失败**:错误信息定格显示,跳出不执行半截工具调用、不保存半截回答

### 2. DeepSeek 深度适配(本项目的差异化点)

后端是 DeepSeek 云端 API(thinking 模式,1M 上下文窗口),很多"表面上的模型行为"其实是协议硬约束,harness 必须从协议层面配合:

- **`reasoning_content` 回传**:带 `tool_calls` 的 assistant 消息必须把本轮 thinking 原文(`reasoning_content`)原样存回 history 再发给 API——DeepSeek 协议规定缺了就返回 400,不是模型偏好。`llm_raw` 事件把原始 SSE 报文落盘,协议层问题可事后诊断
- **上下文缓存友好**:运行时状态(模式、todo 清单)每轮注入时放在**消息尾部**而不是拼进 system 前缀——前缀第一个 token 变化会让 DeepSeek 的上下文缓存整体 miss,尾部注入让静态前缀照常命中
- **流式 + 真实用量**:SSE 边来边吐 reasoning/content;用最后一个 chunk 携带的**真实** `prompt_tokens` 触发压缩阈值,不做本地估算
- **网络韧性**:指数退避 + 抖动重试,只重试"对方抖了"类错误(429/5xx/网络异常),4xx(参数错/鉴权错)重试无意义直接抛,且带响应体——DeepSeek 的 400 体里有具体原因,不看体等于盲调

### 3. 工具系统与权限安全

11 个工具:`read_file` / `list_dir` / `glob` / `grep` / `write_file` / `edit_file` / `bash` / `search_history` / `todo` / `enter_plan_mode` / `exit_plan_mode`。每个工具是 `def`(给模型的描述)+ `handler`(实现)两个文件约定,注册进 `registry`,失败统一返回 `"错误："` 前缀(供观测层据此判 `ok`)。

**权限门**(`permissions.ts`)是安全核心——换到云端大模型后,模型真的能执行 `rm -rf`,"能力不够所以干不了坏事"的隐性保护没了,harness 给工具的权限 = 用户本人的权限,中间必须有一道闸:

- **三级决策**:`auto`(纯只读直接放行)/ `ask`(有副作用先问)/ `deny`(硬禁止,问都不问)
- **危险命令识别**:`rm -rf`、`sudo`、`git reset --hard`、`git push --force`、`curl | sh` 管道执行、覆写 `.env` 等,特征正则识别,**不可会话放行**——即使会话级 allowlist 放行了 `bash`,每次也必问
- **只读白名单带逃逸检测**:`ls`/`cat`/`grep`/`git status` 等整条命令命中才 `auto` 放行;同时检测逃逸口子(`find -delete`、`awk system()`、`tsc` 不带 `--noEmit` 会写产物)
- **配置级 deny**:settings.json 里 deny 的工具对模型**不可见**(直接从 tools 列表移除,而不是发了再拒绝)
- 每次授权决策记 `approval` 事件,事后可复盘"模型尝试危险操作的频率"

### 4. 系统提示词工程

提示词不是一大坨文本,而是模块化组装 + 版本管理 + 运行时注入:

- **A+B+C+D 四段式**:身份(`baseIdentity`)/ 工具纪律(`toolRules`)/ 验证纪律(`verification`)/ 工作流(`workflow`),`PROMPT_VERSION`(当前 v6)每次改动即升级
- **项目类型探测**:启动时探测 `package.json`/`go.mod`/`Cargo.toml`…,把"这是什么项目"注入身份层——装成全局命令后模型面对的是任意用户的任意项目,不能靠猜
- **按项目类型给验证命令**:TS 项目建议 `npx tsc --noEmit`,Go 建议 `go build ./...`,而不是硬编码一种
- **plan 模式**:workflow 段二选一,`enter_plan_mode` 只读调研 → 计划写入独立目录(plan 模式下对其它路径的写会被拒绝)→ `exit_plan_mode` 提交审批,批准才切回正常模式
- **A/B 基线**:`PROMPT_VERSION=none` 跑无系统提示词基线,版本变化的效果用 trace 数据对比
- **运行时状态每轮注入**:模式 + todo 清单作为独立消息段,与静态正文分离

### 5. 上下文管理(1M 窗口)

- **无损转录 vs 有损发送视图分离**:落盘的历史完整无缺(续话用),发给模型的则是压缩/裁剪后的投影
- **LLM 摘要压缩**:超阈值时调用模型,把旧历史压成结构化快照(目标/约束/关键结论/文件与命令/任务状态),只保留后续行动必需的信息;摘要只给模型读,用 Markdown 小节而非伪 XML——半闭合标签会让模型输出结构随机漂
- **CJK 感知的 token 估算**:中文约 1 字符/token、拉丁文约 4 字符/token,分开计权——纯中文转录按 3.5 一刀切会被严重低估,压缩在最需要它的时候失效
- **压缩失败分级降级**:压不动但有超长单条消息 → 单条上限截断兜底;彻底压不动 → 明确记一条 error 提示该换大窗口,而不是静默硬发到 API 报 400

### 6. 可观测性

所有事件落盘到 `~/.coderig/trace.jsonl`(跨运行累积,`CODERIG_HOME` 可指回项目内跑实验),16 种事件类型,每条带 `sid`/`seq`/`round`/`ts` 四维索引——一次运行 = 一个 `sid`,可以切出单次会话做前后对比。写盘串行化,保证行序 = 事件序;崩溃也有部分 trace。

### 7. 双渲染后端

同一套 `chat.ts` 主循环通过 `Term` 接口驱动两种终端 UI:

- **线性模式**:Clack 输入框 + 流式输出(适合管道/简单场景)
- **TUI 模式**:Ink + React,`Static` 回卷(已落定内容可上滚)+ 底部 live 流式区 + 模态交互(输入/确认/选择);Ctrl+C 语义统一处理,先卸载恢复终端再走收尾

---

## 架构

```
index.ts                    CLI 入口(命令解析、配置引导、快照恢复)
bin/coderig                 分发入口(平台探测,内置 runtime 的单文件编译产物)
src/
├── cli/
│   ├── chat.ts             agent loop:判停、工具执行、权限门、压缩触发、收尾轮
│   ├── doom_loop.ts        死循环检测(纯函数,可单测)
│   ├── render.ts           线性渲染后端(Clack)
│   ├── tui/                TUI 渲染后端(Ink + React:回卷/live 区/模态)
│   ├── snapshot_cmd.ts     快照列出/恢复命令
│   └── setup.ts            配置向导
├── llm/
│   ├── client.ts           DeepSeek 客户端:SSE 流式、重试、thinking 协议、缓存友好
│   ├── stream.ts           SSE 字节流 → StreamEvent 解析
│   └── types.ts            消息/工具/事件类型
├── tools/                  工具系统(11 工具 + registry + 权限门 + 快照)
│   ├── permissions.ts      权限门:三级决策、危险命令识别、只读白名单
│   ├── partition.ts        两阶段工具执行、并行波次、文件锁冲突检测
│   ├── snapshot.ts         改动快照(改前留底,可恢复)
│   └── context.ts          会话上下文(模式/todo 状态)
├── history/
│   ├── store.ts            无损转录持久化(续话基础)
│   ├── context.ts          有损发送视图、压缩触发阈值
│   └── compact.ts          LLM 摘要压缩(结构化快照模板)
├── prompts/system.ts       sysprompt 模块化组装(版本化、A/B 基线)
├── config/                 配置层(env > 文件 > 向导)与路径收敛
└── observability/tracer.ts 观测(16 种事件、跨运行累积)
```

数据流(一次任务 = 多条 HTTP 流,每轮一条):

```
用户输入 ──► agent loop(chat.ts)
              │  sendMessages ──► DeepSeek SSE 流式
              │    ├─ reasoning/content → 边来边渲染(TUI/线性)
              │    ├─ tool_calls → 权限门(auto/ask/deny) → 执行工具 → 回填 history
              │    └─ usage(真实 token) → 触发压缩阈值检查
              │  ←─ 无 tool_calls = 最终回答,停止
              │  ←─ 超轮数/死循环 → 收尾轮(禁工具,让模型总结)
              └─ 全程事件落盘 trace.jsonl(sid/seq/round/ts)
```

---

## 设计决策(面试聊点)

一些值得展开讲、也经得起追问的取舍:

- **判停为什么不解析 `finish_reason`**:`[DONE]` 只是传输层 EOF,"这轮流传完了"≠"回答完了"——多轮 agent loop 里每轮都有 `[DONE]`,真正的停止信号是"本轮无 tool_calls"。`finish_reason` 只作兜底校验
- **运行时状态放尾部而不是拼进 system**:DeepSeek 上下文缓存对前缀敏感,前缀第一个 token 变化 → 整体 miss → 每轮都白付完整前缀的输入费用。尾部注入让静态前缀缓存照常命中
- **压缩用真实 `prompt_tokens` 而不是本地估算**:估算是有损近似(尤其中文),而 API 返回的 usage 是事实;压缩决策应该建立在事实上
- **收尾轮而不是硬停**:轮数上限/死循环不是"卡死就杀进程",而是禁用工具发最后一轮,让模型交代进度——opencode 的做法,对用户的信息价值高一个数量级
- **权限门的三级而不是两级**:`deny` 解决"问都不该问"的操作(覆写 `.env` 这类无正当场景的),`ask` + `rememberable` 解决"可授权但要有记录"的,`auto` 解决"纯只读"的——噪音与安全之间取平衡
- **为什么自研而不是套框架**:agent 系统的每个决策(判停、压缩、权限)都依赖对模型协议的具体理解,只有亲手实现一遍,才知道这些边界在哪里

---

## 质量保障

- **29 个单测文件**,覆盖:判停与轮数控制、权限分级与危险命令识别、压缩触发与 CJK 估算、死循环检测、SSE 解析、双渲染后端(含 TUI 组件测试)
- `bunx tsc --noEmit` 类型检查严格通过
- 核心逻辑(判停、权限、压缩、doom loop)拆成纯函数,可脱离 I/O 单测
- `bun run build` 编译全平台二进制(`darwin/linux/windows × arm64/x64 + linux-musl`),`bun build --compile` 内置 runtime 分发

## 开发

```bash
bun install
bun run index.ts          # 从源码跑
bun test                  # 单测
bunx tsc --noEmit         # 类型检查
bun run build             # 编译全平台二进制到 dist/
```

跑 sysprompt A/B 实验:

```bash
TRACE_PATH=logs/trace.jsonl CODERIG_HOME=./logs bun run index.ts
PROMPT_VERSION=none bun run index.ts   # 无系统提示词基线
```
