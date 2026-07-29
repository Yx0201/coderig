# CLAUDE.md — coderig 项目协作规则

本文件是给 Claude Code 看的工程约定。动手前先读,改代码时遵循。

---

## 0. 项目定位

coderig 是一个**学习用**的 mini agent harness:终端 CLI + 工具系统 + 可观测性(tracer)。
后端已于 2026-07-29 从 ollama 本地小模型(qwen3.5:4b)切换为 DeepSeek 云端 API
(1M 窗口,thinking 模式——带 tool_calls 的 assistant 消息必须回传 reasoning_content,
这是 DeepSeek 的协议硬约束,不是模型偏好)。

它不是产品,是"自己实现一遍 Claude Code 的核心机制"的练习场。架构和教学性优先于功能完整度。

---

## 1. 核心规则:harness 问题 vs 小模型问题(最重要)

**小模型是让 harness 边界问题暴露得更明显的手段,不是要我们去修补的对象。**

我们之后会替换掉 ollama + 本地小模型,换成云端大模型(DeepSeek V4 Pro / GLM-5.2 /
Claude Opus / GPT-5.x 这类)。因此:

- **遇到任何问题,第一步是拆分责任归属**——这是 **harness 的缺陷**,还是 **小模型的边界行为**?
  - harness 缺陷 = 我们代码没兜住、逻辑有漏洞、缺守卫、解析有误……**必须修**。
  - 小模型问题 = 4b 模型产出差、放错字段、半途停、不遵循指令、能力不足……**不针对它做边界补丁**。
- **不为小模型的边界行为写 workaround**。例如不要为了让 qwen 把答案放进 content 而加一堆特殊解析逻辑。
  这种补丁在换上大模型后要么失效、要么反而添乱。
- 换成大模型后大概率会自然消失的行为,就留给大模型去消除,不要现在投入。

**怎么判断归属(经验法则):**

| 现象 | 归属 | 说明 |
|---|---|---|
| 模型输出格式怪异(如答案放进 reasoning 而非 content) | 小模型 | 大模型通常规范,留给替换解决 |
| 模型半途 `finish_reason: stop`、想完不行动 | 小模型 | 能力不足,不针对它打补丁 |
| 模型不遵循 sysprompt 里的多条规则 | 小模型 | 4b 遵循能力有限,大模型会好 |
| harness 对空回答/异常 finish_reason 没有兜底 | **harness** | 任何模型都可能偶发空回答,必须兜 |
| harness 不解析 finish_reason 就判停 | **harness** | 协议层处理,与模型大小无关 |
| 缺 nudge/续轮机制 | **harness** | 大模型偶尔也会空收尾,该有 |
| tracer 落盘乱序、终端显示闪烁等 | **harness** | 纯观测层 bug |
| 工具失败被记成成功 | **harness** | 统计口径 bug |

一句话:**模型负责"产出什么",harness 负责"产出差的时候怎么兜"。** 前者等替换,后者现在修。

---

## 2. 代码风格

- TypeScript,跑在 Bun 上。项目去 Bun 依赖的地方就用 `node:fs/promises` 这类可移植原生 API。
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
  一次运行 = 一个 `sid`,靠每条事件的 `sid` 切出单次运行做前后对比;
  要重开一份干净日志时手动删除该文件,代码不再自动清。
- 每条事件带 `sid` + `seq` + `round` + `ts`。
- `session_start` 记实验元数据:`promptVersion` / `systemPromptChars` / `model`。
  改 sysprompt 就升 `PROMPT_VERSION`(`src/prompts/system.ts`),前后对比全靠它。
- `PROMPT_VERSION=none` 跑无系统提示词基线;缺省用最新版本。
- 大输出/原始报文都要截断(见 tracer 里的 `PREVIEW_LEN` / `RAW_CHUNK_LEN`),防撑爆文件。

---

## 4. 实验与对比

做提示词/行为 A/B 时:固定一组任务,两组各跑一遍(基线 vs 实验组),
每次 `ctrl+c` 退出触发 `session_end`,一次运行 = 一个 sid = 一组实验。
小模型方差大,单次结果说明不了问题,每组至少 2~3 遍看趋势。
