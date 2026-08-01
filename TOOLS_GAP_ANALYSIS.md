# 工具系统差距分析:harness CLI 产品 vs coderig

> 调研日期:2026-07-31 · 分支:feat/tools_expand
> 调研对象:Claude Code(官方文档 + DeepWiki 源码剖析)、OpenAI Codex CLI(Rust 源码)、
> sst/opencode(TS 源码)、Gemini CLI(源码)、Cursor、aider(文档 + 源码)。
> 目的:按 **精确性 / 边界约束 / 丰富程度 / 必备工具 / 调用与注册** 五个维度找差距,产出优化路线图。
> 判据遵循 CLAUDE.md 核心规则:只补 harness 层(边界兜底),不为模型边界行为写补丁。

---

## 0. 我方现状盘点

工具全集(8 个,`src/tools/`):

| 工具 | 参数 | 边界约束 | mutates |
|---|---|---|---|
| `bash` | command, timeout | 缺省 30s / 最大 120s;输出 4000 字符头尾截断 | ✓(总是串行) |
| `read_file` | path, offset, limit | 缺省 200 行 / 上限 1000;尾注"还有 N 行" | – |
| `write_file` | path, content | 无 | ✓ |
| `edit_file` | path, oldString / start_line+end_line, newString | 唯一匹配严格校验 / 行号区间锚点 | ✓ |
| `glob` | pattern, path | 无结果上限;排除 node_modules/.git | – |
| `grep` | pattern, path, isRegex | 20 文件 / 每文件 5 行 / 行 100 字符;无超时 | – |
| `list_dir` | path, recursive | 无上限 | – |
| `search_history` | query, cid, isRegex | 15 条命中 | – |

注册与调度:`registry.ts`(def + handler + mutates)→ `chat.ts` 只读并行 / 写串行 → 权限门
(auto/ask/deny + bash 命令分级 + 敏感路径硬禁)。全部 8 个工具每次请求全量注入。

**trace 实证(5 session, 58 次调用)**:`read_file` 27 > `bash` 14 > `list_dir`/`glob` 各 6 >
`write_file` 4 > `edit_file` 1;**`grep`、`search_history` 从未被调用**;bash 里模型反复手写
`cd /Users/… && …`(bash 无 cwd 参数)。

---

## 1. 五维差距分析

### 1.1 精确性(description / schema 的防误用程度)

**行业标准写法**(Gemini read_file / opencode read.txt 是样板):description 内嵌
`适用场景 + 参数语义 + 失败条件 + 输出上限 + 何时该换别的工具` 五段信息;参数 schema
中粗粒度(类型 + 描述 + required),但**把默认值、上限、边界行为全部写进参数描述**;
错误消息 = 下一轮的行动指令(Read 超 token 直接教"用 offset/limit 或 Grep")。

**我方差距**:

| # | 差距 | 证据 | 归属 |
|---|---|---|---|
| P-1 | 描述缺"失败条件"与"换工具指引" | read_file 没说"要全文总结用大 limit、找内容用 grep";glob/grep 职责边界未写清 | harness |
| P-2 | `bash` 无 `cwd` 参数 | trace 里模型反复 `cd … && …` | harness |
| P-3 | schema 未封死未知参数 | 无 `additionalProperties: false`,模型可塞多余字段 | harness |
| P-4 | 错误消息缺修复指引 | edit_file "未找到 oldString" 已提示查缩进;read_file 超限无"改用 grep / 续读"指令 | harness |
| P-5 | 描述硬编码在代码里 | opencode 用 `.txt` 模板分离实现与描述,利于 sysprompt A/B(本仓库正处于 A/B 阶段) | harness |

**已达标**:bash 描述已写"查看文件请用 read_file,搜索请用 grep"——与 Claude Code 的
"Prefer dedicated tools over cat/sed/grep" 同构;snake_case 参数与行业一致。

---

### 1.2 边界约束(截断 / 超时 / 校验 / 权限)

**行业数字参照**:

| 项 | Claude Code | opencode | Gemini | 我方 |
|---|---|---|---|---|
| read 上限 | 2000 行 / 25k token,超限报错引导 | 2000 行 / 50KB,超限落盘 | 显式导航"Action: start_line: N" | 200/1000 行,尾注续读 |
| grep 上限 | head_limit 250 + offset + `-A -B -C` | 100 条 | 100 条 / 30s 超时 | 20 文件/5 行,**无超时、无上下文** |
| glob 上限 | 有 | 100 条 | 有 | **无上限** |
| bash 超时 | 120s 缺省/600s 最大 | 配置化 | – | 30s/120s(更保守,可接受) |
| bash 大输出 | 30k 字符 + 落文件给 Read | 全文落盘 + 预览 + 指引 | LLM 摘要保错误栈 | **4000 字符纯截断,中间信息丢** |

**权限模型对照**:Claude Code `ToolName(pattern)` 规则、deny→ask→allow 求值、settings.json
五层持久化;opencode deny-first + last-match-wins + SQLite 持久批准 + reject 带
`CorrectedError.feedback` 回传模型 + **被 deny 工具从模型可见列表隐藏**;Gemini
allow/deny/ask_user 三态 + `argsPattern` 参数级规则;Cursor Checkpoints / aider auto-commit 做
**改动回滚安全网**。我方 auto/ask/deny + bash 分级 + 敏感路径,思路与 Claude Code 高度一致
(注释里也写了参考过),属行业中间档(比 aider 强、比 Cursor 的 classifier 简单但更可预期)。

**我方差距**(全部 harness 层):

| # | 差距 | 说明 |
|---|---|---|
| B-1 | glob / list_dir 无结果上限 | 大仓库 `**/*` 直接把 context 撑爆,这是最该补的护栏 |
| B-2 | bash 大输出只截断不落盘 | 4000 字符头尾截断丢中间;行业做法是超限落盘到状态目录、返回文件路径让 read_file 续读 |
| B-3 | grep 缺 `-A -B -C` / 单行截断 / 超时 | 命中行没上下文,模型常要再 read_file 才能定位;无超时大仓库可能挂死 |
| B-4 | read_file 无二进制检测 | 读二进制文件吐出乱码(行业用 NUL / 非打印字符比例判断) |
| B-5 | edit_file 无并发修改检测 | 无 SHA256 校验,读后文件被外部改过仍会基于旧内容编辑 |
| B-6 | 无 read-before-write 强制门 | Claude Code / opencode 都强制"Edit 前必须 Read 过",防基于过期内容修改 |
| B-7 | 权限无持久化 | 会话 allowlist 是内存 Set,重启即失;Claude Code 有 settings.json 层级 |
| B-8 | 拒绝文案缺"修复指引"回传 | opencode 的 reject 会带 CorrectedError.feedback 教模型怎么改;我方 deny/ask 拒绝文案已部分有(不换皮重试),可再补强 |
| B-9 | 无改动回滚安全网 | Cursor Checkpoints / aider auto-commit 均有;我方破坏性操作(bash rm 等)被 permission 挡住但无 undo 兜底 |
| B-10 | 被 deny 的工具仍暴露给模型 | opencode `visibleTools` 会直接隐藏,减少误调 |

**已达标**:edit_file 双模式(唯一替换 + 行号锚点)比 Claude Code 单模式更稳;错误"错误："
前缀 + tracer 判 ok,是"失败即输入、让模型自纠"哲学的雏形。

---

### 1.3 丰富程度(工具覆盖面)

行业产品工具面(2026-07):

- **Claude Code**:Bash / Read / Write / Edit / NotebookEdit / Glob / Grep / LSP / Task / TaskOutput /
  TaskStop / KillShell / WebFetch / WebSearch / TodoWrite / AskUserQuestion / EnterPlanMode /
  ExitPlanMode / Skill / ToolSearch / MCP(40+ 个)
- **Codex**:apply_patch(FREEFORM 语法) / shell_command / exec_command / plan(update_plan) /
  tool_search / view_image / get_context_remaining / request_permissions / request_user_input /
  mcp / multi_agents
- **opencode**:read / edit / write / apply_patch / shell / glob / grep / websearch / webfetch /
  task(子代理) / todowrite / skill / plan / lsp / question / invalid(兜底) / MCP resources
- **Gemini**:run_shell_command / read_file / read_many_files / glob / grep_search / replace /
  write_file / list_directory / ask_user / write_todos / enter_plan_mode / exit_plan_mode /
  google_web_search / web_fetch / MCP resources / activate_skill / complete_task / tracker_*

**我方差距**:按类别分,缺四块:

| 类别 | 代表工具 | 必要性 | 归属 |
|---|---|---|---|
| **规划** | TodoWrite / update_plan / write_todos | **高** — 全行业都有,是"模型先规划再执行"的最低成本 harness 机制(状态每轮可见) | harness |
| **人机交互** | AskUserQuestion / ask_user / question | 中 — 我方只有 doom-loop 的 select,无通用提问 | harness(UI) |
| **网络** | WebFetch / WebSearch | 低-中 — 对纯本地编码助手非核心 | 产品形态 |
| **子代理** | Task / complete_task / multi_agents | 低-中 — 机制是 harness,但自包含 prompt 质量靠模型 | harness(偏重) |
| **上下文预算** | get_context_remaining | 中 — 显式暴露余量给模型决策 | harness |
| **MCP / 插件** | mcp / skill | 低 — 学习型项目排期靠后 | 工程规模 |
| **plan 模式** | enter_plan_mode / ExitPlanMode | 低-中 — 只读研究模式 | 产品形态 |

---

### 1.4 必备工具(行业收敛 vs 我方)

行业在"一个编码 agent 必须有的工具"上高度收敛:**读文件 + 写文件 + 局部编辑 + 按名搜索
(glob) + 按内容搜索(grep) + 跑命令(shell)** —— 这六件我方**全部具备**,且方向正确
(JSON Schema + mutates 并行门 + 错误前缀,落在大盘上)。

真正缺的"必备"级只有两件:**规划工具(todo/plan)**,以及与之配合的 **规划状态每轮回显**
(Claude Code 的 todo 活在 tool_result 上下文里,模型每轮看得到,防重复编辑/漏做)。

> aider 是唯一没有工具系统的产品(LLM 直接输出 diff),属另一条路线;对已定型的
> tool-calling harness,值得学的是它的 repo map(上下文选择)与 git 兜底,不是转向 edit format。

---

### 1.5 工具的调用与注册

**行业机制**:

- **注册**:def(JSON Schema)+ handler 进 registry(Claude Code 同构);opencode 用
  `Tool.define(id, Effect)` + 内置/用户目录/插件三方聚合;描述与实现分离(`.txt` 模板)。
- **并行**:三家收敛于"只读并行、写串行"。Claude Code 更进一步,**按调用内容细判**
  (`isConcurrencySafe`:bash 只读命令也可并行,顺序敏感分段);opencode 用**每文件信号量锁**
  (同文件串行、不同文件可并行)而非全写串行;Codex 每个 handler 声明
  `supports_parallel_tool_calls()`。
- **裁剪**:Gemini 按模型家族换整套 schema/描述(per-model tool sets);Cursor 工具描述懒加载
  (只给名字列表、按需拉详情,实测总 token 降 46.9%);Codex 有 tool_search 动态发现。
- **失败归一化**:Codex `FunctionCallError::RespondToModel`、opencode Effect.orDie——全部工具
  错误统一转成"给模型读的文本",且**面向模型写(带修复指引)**,不 dump 堆栈。

**我方差距**:

| # | 差距 | 说明 |
|---|---|---|
| R-1 | `mutates` 静态按工具,非按调用 | `bash` 永远串行,连只读的 `ls` 也串行;Claude Code 按命令内容细判。且 bash 只读命令本可并行 |
| R-2 | 全量工具每次注入,无裁剪 | 8 个全塞;未来加 todo/web/task 后 token 膨胀,需要 per-model / 按需加载 |
| R-3 | 无每文件锁 | 当前"全写串行"安全但保守;不同文件的两处 edit 本可并行 |
| R-4 | 失败归一化可加修复指引 | "错误："前缀已对,可像 Codex 一样每条错误带"下一步怎么做" |
| R-5 | 描述与实现耦合 | 描述改一次要动代码;opencode 的 `.txt` 分离利于 A/B(本仓库 A/B 阶段) |

---

## 2. 优化路线图(feat/tools_expand)

按"harness 层、ROI 高、不补模型边界"排序。每步都升 PROMPT_VERSION(改 sysprompt/描述时)。

### Phase 0 · 精确性规范化(纯文案,零风险)

1. **描述五段式模板**:每条 def 按 `适用场景 + 参数语义 + 失败条件 + 输出上限 + 换工具指引`
   重写;给 glob/list_dir 补结果上限说明、给 write_file 补覆写警告、给 edit_file 强调"局部修改
   优先于整写"。
2. **bash 补 `cwd` 参数**(实证 trace:模型总在 `cd … && …`),同时权限判定用解析后的 cwd。
3. **schema 补 `additionalProperties: false`**;关键参数补示例。
4. **read_file 超限报错引导**:超出 limit 时错误消息直接写"用 grep 找内容 / 用 offset=N 续读"。

### Phase 1 · 边界约束收紧(harness 兜底核心)

5. **glob/list_dir 结果上限**(如 200 条)+ 截断提示"结果过多,请缩小 pattern"。
6. **grep 升级**:加 `-A -B -C` 上下文行数、单行截断(500 字符)、搜索超时(30s)、
   VCS 目录排除。参考 Gemini 的 `total_max_matches=100` 与 30s 超时。
7. **read_file 二进制检测**:NUL / 非打印字符比例判断,拒绝输出乱码。
8. **bash 大输出落盘**:超过阈值(如 4000 字符)写入 `coderigHome()/tmp/` 文件,
   返回"输出已落盘,路径 X,请用 read_file 续读"——行业三家用不同方式都做这步。
9. **edit_file 冲突检测**:编辑前 SHA256,写前比对,文件被外部改过就报错让模型重读。
10. **read-before-write 强制门**:会话内记 readPaths Set,Edit/Write 前若 path 未 Read 过,
    拦截并提示先 read_file。

### Phase 2 · 权限与回滚安全网

11. **权限规则持久化**:allow 规则写 `~/.coderig/settings.json`(配合 paths.ts),deny-wins 语义
    显式化;会话 allowlist 与持久 allow 合并。
12. **拒绝文案带修复指引**:deny/ask 拒绝消息附"该怎么做才对"(opencode CorrectedError 风格),
    已有雏形("不要换皮重试")再补强。
13. **改动快照 / undo 兜底**:写工具(write/edit/bash 的 mutating 命令)执行前把受影响文件
    快照到 `coderigHome()/snapshots/`,支持事故回滚(轻量版 Cursor Checkpoints / aider auto-commit;
    对学习项目先做"记录被改文件+原内容"即可,不做完整 git 集成)。

### Phase 3 · 必备工具与调度升级

14. **todo 规划工具**(照 opencode todowrite / Codex update_plan):纯内部状态,不碰文件系统;
    `pending/in_progress/completed` 三态,一次调用替换整个列表;结果回填进上下文每轮可见。
    这是全行业都有的"规划即状态"机制,成本最低、价值最高。
15. **按调用内容细判并行**:bash 只读命令(复用 permissions 的 classifyBash)并行、写命令串行;
    写工具改**每文件锁**(不同文件可并行编辑)。
16. **被 deny 工具隐藏**:deny 且 pattern=* 的工具直接从 listDefs() 剔除,减少模型误调。

### Phase 4 · 大特性(视需要,排期靠后)

17. **子代理 Task 工具**(context 隔离 + 并行扇出)。
18. **MCP client**(schema 懒加载,参考 Cursor 的按需拉详情)。
19. **WebFetch / WebSearch**。
20. **plan 模式 / ask_user 交互工具**。
21. **repo map / 上下文选择**(aider 思路,解决大仓库 token 与检索精度)。

---

## 3. 不做清单(按 CLAUDE.md 判责)

| 候选 | 为什么不学 |
|---|---|
| 9 种模糊 matcher(opencode)/ fuzzy 降级(Gemini) | 是给"模型 old_string 抄不准"的补偿 = 修模型边界行为;我方已有行号区间锚点作为替代,大模型替换后精确率会高 |
| apply_patch 自由格式(Codex Lark grammar) | 依赖 OpenAI custom tools 语法约束协议;DeepSeek 是标准 function calling,我方 JSON schema 路线更适配 |
| tool_search 动态发现 / code-mode | 依赖模型运行时装载工具集,大模型还在实验期 |
| Cursor Apply model 整文件重写 | 模型/推理基建,与 tool-calling 路线相反 |
| Cursor LLM classifier 审批 | 官方自认非安全边界,非确定性 |
| aider edit format(LLM 输出 diff) | 不做 tool-calling 的另一路线,不改方向 |
| NotebookEdit / LSP | IDE/语言服务器生态,纯终端 CLI 意义不大 |

---

## 4. 结论(一句话)

我方架构方向(JSON Schema + mutates 并行门 + 错误前缀 + 权限门)落在行业主流里,
**描述写法甚至比多数产品到位**;真实差距在三块——**边界护栏不全(glob/list_dir 无上限、
bash 输出丢中段)、编辑与回滚兜底浅(无冲突检测、无 undo、无 read-before-write)、
缺规划工具与工具裁剪(todo、per-call 并行、按需注入)**。Phase 0~2 是纯 harness 层、
成本可控,建议按序落地。
