# CLAUDE.md — coderig 项目协作规则

本文件是给 Claude Code 看的工程约定。动手前先读,改代码时遵循。

---

## 0. 项目定位

coderig 是一个 agent harness:终端 CLI + 工具系统 + 可观测性(tracer)。
后端已于 2026-07-29 从 ollama 本地小模型(qwen3.5:4b)切换为 DeepSeek 云端 API
(1M 窗口,thinking 模式——带 tool_calls 的 assistant 消息必须回传 reasoning_content,
这是 DeepSeek 的协议硬约束,不是模型偏好)。

---

## 1. 核心规则:harness 边界 vs DeepSeek 模型问题(最重要)

后端已固定为 DeepSeek 云端 API。遇到任何问题,**第一步永远是拆分责任归属**——
这是 **harness 的缺陷**,还是 **DeepSeek 模型的边界行为**?

- **harness 缺陷** = 代码没兜住、逻辑有漏洞、缺守卫、解析有误、协议层没配合……**必须立刻修**。
  这类问题与模型无关,任何模型都可能踩中,修了对所有模型生效。
- **DeepSeek 模型问题** = 模型产出差、放错字段、半途停、不遵循指令、能力不足……
  **可以针对性优化,但必须受治理**(见下)。不能只修一版就丢着不管。

### DeepSeek 针对性优化的治理(每次模型升级必须验证)

可以为 DeepSeek 写针对性优化,但每一处都必须同时满足三条,缺一不可:

1. **详细注释**:写明"这是针对 DeepSeek 的优化、针对什么现象、为什么有效",
   注释统一带 `[DeepSeek适配]` 标记——保证 `grep -rn "\[DeepSeek适配\]" src/`
   能一次列出全部适配点,这是模型升级时的验证清单。
2. **验证义务**:每次 DeepSeek 模型升级(或换同系新模型),把 grep 出来的适配点
   逐个验证:问题还在吗?优化还必要吗?
3. **及时清理**:验证后发现边界情况已消失的,立即删掉对应优化(代码 + 注释),
   不为不存在的边界留死代码。

> 与早期"不为小模型写 workaround"的区别:当时后端还要换,补丁注定作废;
> 现在 DeepSeek 是既定后端,针对性优化有长期价值。但模型在升级,优化有保质期,
> 所以用"标记 + 验证 + 清理"治理,而不是一禁了之。

**怎么判断归属(经验法则):**

| 现象 | 归属 | 处理 |
|---|---|---|
| 模型输出格式怪异(如答案放进 reasoning 而非 content) | 模型 | 确认是 DeepSeek 稳定行为后可优化,走治理流程(带 `[DeepSeek适配]` 注释) |
| 模型半途 `finish_reason: stop`、想完不行动 | 模型 | 可针对性优化(如 nudge 参数),走治理流程 |
| 模型不遵循 sysprompt 里的多条规则 | 模型 | 提示词工程可优化,走治理流程 |
| harness 对空回答/异常 finish_reason 没有兜底 | **harness** | **立刻修**,任何模型都可能偶发空回答 |
| harness 不解析 finish_reason 就判停 | **harness** | **立刻修**,协议层处理,与模型无关 |
| 缺 nudge/续轮机制 | **harness** | **立刻修**,大模型偶尔也会空收尾 |
| tracer 落盘乱序、终端显示闪烁等 | **harness** | **立刻修**,纯观测层 bug |
| 工具失败被记成成功 | **harness** | **立刻修**,统计口径 bug |

一句话:**模型负责"产出什么",harness 负责"产出差的时候怎么兜"。**
模型问题可以优化,但必须带标记、可验证、可清理;harness 问题永远立刻修。

---

## 2. 代码风格

- TypeScript,跑在 Bun 上。2026-07-31 起产品化:Bun 是唯一 runtime(经
  `bun build --compile` 分发,内置 runtime),**文件/进程 API 一律用 Bun 专有 API**
  (`Bun.file` / `Bun.write` / `Bun.Glob` / `Bun.spawn`),不再为可移植性写 `node:fs` 兼容层。
  三个刻意例外,不是"没迁完的尾巴",别再动:
  - `node:path`(join/relative/dirname):纯字符串工具,Bun 无对应 API;
  - `node:fs/promises` 的 `appendFile` / `readdir`:高频小追加和列目录,Bun 的替代
    (writer 每次开关文件、Glob 列目录)反而更绕;
  - `node:fs` 的 `existsSync` / `node:os` 的 `homedir`:Bun 无同步等价物。
  注意 `Bun.file(dir).exists()` 对**目录**返回 false,判目录存在用 readdir 捕获 ENOENT。
- 新工具加在 `src/tools/`,遵循 `def` + `handler` + 导出 `{ def, handler }` 的约定,
  失败统一返回 `"错误："` 前缀(被 tracer 据此判 `ok`)。注册到 `src/tools/index.ts`。
- 工具执行前必须过权限门(`src/tools/permissions.ts`):auto/ask/deny 三级,
  mutating 工具默认询问,危险命令与敏感路径不可会话放行(rememberable=false);
  用户的选择记 `approval` 事件。新增 mutating 工具时在 checkPermission 里补一条分支。
- 观测全走 `src/observability/tracer.ts`:新事件类型加进 `TraceEvent.type`,加对应方法,
  落盘靠 `push()`(已串行化写盘,保证行序=事件序)。不要在底层(stream.ts 等)直接塞 tracer,
  观测数据顺着 StreamEvent 管道流到 chat.ts 再调 tracer。
- 注释用中文,说明"为什么这么做"而非"做了什么"。

---

## 3. 可观测性约定

- `logs/trace.jsonl` 跨运行累积(2026-07-29 起,骨架阶段已过,进入 sysprompt A/B 阶段)。
  **2026-07-31 产品化后,默认路径改为 `~/.coderig/trace.jsonl`**(见 `src/config/paths.ts`)——
  装成全局命令后跑在别人的项目里,状态不能写进用户仓库。本仓库的 A/B 实验照旧:
  用 `TRACE_PATH=logs/trace.jsonl CODERIG_HOME=./logs bun run index.ts` 把状态指回项目内。
  一次运行 = 一个 `sid`,靠每条事件的 `sid` 切出单次运行做前后对比;
  要重开一份干净日志时手动删除该文件,代码不再自动清。
- 每条事件带 `sid` + `seq` + `round` + `ts`。
- `session_start` 记实验元数据:`promptVersion` / `systemPromptChars` / `model`。
  改 sysprompt 就升 `PROMPT_VERSION`(`src/prompts/system.ts`),前后对比全靠它。
- `PROMPT_VERSION=none` 跑无系统提示词基线;缺省用最新版本。
- 大输出/原始报文都要截断(见 tracer 里的 `PREVIEW_LEN` / `RAW_CHUNK_LEN`),防撑爆文件。

---

## 5. 分发与配置约定(2026-07-31 产品化新增)

- **状态文件路径一律走 `src/config/paths.ts`**(`coderigHome()` / `configPath()` /
  `tracePath()` / `historyDir()`),不准再写相对路径——相对路径会解析到 `process.cwd()`
  = 用户的仓库。这几个是惰性函数不是常量:常量会在模块 import 时冻结 env,Bun 模块缓存
  让"先 import 再设 env"的覆盖静默失效(测试里踩过)。
- **配置读取一律走 `src/config/index.ts` 的 `getConfig()`**:优先级 env > config.json >
  向导。`client.ts` 这类底层模块不能在模块顶层读 `process.env`——import 时配置还没
  就绪(向导的值到不了),必须在函数内取。
- **编译必须 `compile.autoloadDotenv: false`**(见 `script/build.ts`):实测不关的话,
  编译产物会吞掉**用户项目**的 `.env`,里面的同名变量(API_KEY/MODEL…)直接污染配置。
- 发包结构照 opencode:壳包 `coderig`(postinstall 探测平台)+ 6 个平台包
  (darwin/linux/windows × arm64/x64 + linux-musl),`bun run build` 出全部产物到 `dist/`。

---

## 6. 实验与对比

做提示词/行为 A/B 时:固定一组任务,两组各跑一遍(基线 vs 实验组),
每次 `ctrl+c` 退出触发 `session_end`,一次运行 = 一个 sid = 一组实验。
模型输出方差大,单次结果说明不了问题,每组至少 2~3 遍看趋势。
