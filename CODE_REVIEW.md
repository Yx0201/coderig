# CODE REVIEW — `feat/tools_expand`

评审日期:2026-08-01 · 评审范围:`feat/tools_expand` 相对 `main` 的全部改动
(20 个文件修改 + 21 个新文件,约 +1550 行,含工具升级与系统提示词升级两块)

基线检查:`bunx tsc --noEmit` 干净;`bun test` 97 pass / 0 fail(18 个文件)。
所以下面的问题**都不是类型错误或测试失败能发现的**——多数是语义/接线层面的缺陷,
现有测试恰好绕过了它们。

---

## 0. 结论摘要

方向是对的:`ToolContext` 注入解决了"工具需要会话记忆"的结构问题,
门(read-before-write / 冲突检测)+ 快照分别回答了"该不该做"和"做错了怎么办",
分区并行把 `mutates` 一刀切细化成了按调用内容判定,sysprompt 拆段让 A/B 有了抓手。

但有 **4 个阻断级缺陷会让本次新增的功能实际跑不起来**(plan 模式必然死锁、
审批"拒绝"被当成"批准"、grep 静默漏搜、并行写引入并发确认框),
另有 10 项正确性/健壮性问题和 8 项设计层面的改进空间。

| 级别 | 数量 | 说明 |
|---|---|---|
| P0 阻断 | 4 | 新功能不可用,或引入了比修好的问题更严重的问题 |
| P1 正确性 | 10 | 会静默给出错误结果、或在边界条件下崩/卡 |
| P2 设计 | 8 | 能跑但代价高、归因困难、或授权范围超出用户预期 |

按 CLAUDE.md 第 1 条做过归属拆分:**下列全部条目均为 harness 缺陷**,
没有一条属于"模型边界行为"——所以都该修,不存在"留给大模型自然消失"的项。

---

## 1. P0 阻断级缺陷

### P0-1 plan 模式的写守卫与给模型的指令不一致 → 规划模式必然死锁

**位置**:`src/cli/chat.ts:411-419`(守卫)、`src/tools/plan_mode.ts:19,39`、
`src/prompts/system.ts` 的 `PLAN_WORKFLOW`

守卫要求写入路径落在 `resolve(plansDir())` 之下,而 `plansDir()` 是
`~/.coderig/plans`;但工具描述、`enter_plan_mode` 的返回文本、`PLAN_WORKFLOW`
三处都只告诉模型"写到 `plans/` 目录下"。模型没有任何途径知道那个绝对路径。

**实测**:

```
plans/impl.md                      -> inPlans = false   (resolve 到 cwd/plans)
./plans/impl.md                    -> inPlans = false
/Users/<me>/.coderig/plans/impl.md -> inPlans = true
```

**后果**:进入规划模式后,模型每次写计划都被守卫拒绝;它会换路径重试
(`plans/`→`./plans/`→`docs/plan.md`),全部失败,直到撞轮数上限或 doom loop。
plan 模式 100% 走不通。

**修复方向**(二选一,推荐前者):

1. 把绝对路径注入指令面:`enter_plan_mode` 的返回文本与 `PLAN_WORKFLOW` 里写
   `计划文件必须写到 ${plansDir()}/ 下`,工具描述同步改。指令与守卫共用同一个
   `plansDir()` 来源,不会再漂。
2. 放宽守卫:同时接受 `resolve("plans")`(用户项目内)和 `plansDir()`。
   但这违反"plan 模式不污染用户项目"的初衷,所以只作为备选。

顺带:守卫只覆盖 `write_file`/`edit_file`,**`bash` 没被覆盖**——plan 模式下
`bash: echo x > src/a.ts` 照样能改项目文件(只受权限门约束)。既然对外声称"只读",
守卫应当在 plan 模式下把 `classifyBash() !== "readonly"` 的 bash 一并拦掉。

---

### P0-2 计划审批里"拒绝"被当成"批准"

**位置**:`src/cli/chat.ts:69`

```ts
confirm: async (msg) => !p.isCancel(await p.confirm({ message: msg })),
```

`p.confirm` 的返回是 `boolean | symbol`:用户选"否"返回 `false`,
`isCancel(false)` 为 `false`,取反得到 `true` → `exit_plan_mode` 判定"已批准",
切回 normal 模式并回复"计划已批准,请严格按计划实施"。

**后果**:用户点"否"和点"是"效果完全相同。唯一能真正拒绝的方式是 `Ctrl+C` 取消。
这是权限/审批类代码里最不能出的一类 bug——UI 上给了否决权,实现上没有。

**修复方向**:

```ts
confirm: async (msg) => {
  const r = await p.confirm({ message: msg });
  return !p.isCancel(r) && r === true;
},
```

同时补一条测试:`ctx.confirm` 返回 false 时 `exitPlanModeHandler` 必须保持
`ctx.state.mode === "plan"`。现有 `plan_mode.test.ts` 用的是默认
`confirm: async () => true`(见 `context.ts:65`),所以这条路径完全没被覆盖。

---

### P0-3 grep 的忽略过滤把正常文件也吃掉了

**位置**:`src/tools/grep.ts:60-63`

```ts
const IGNORED_DIRS = ["node_modules", ".git", ".svn", ".hg", "CVS"];
const isIgnored = (f: string) =>
  IGNORED_DIRS.some(
    (d) => f.includes(`/${d}/`) || f.startsWith(`${d}/`) || f.includes(d),
  );
```

第三个条件 `f.includes(d)` 是裸子串匹配,而 `d` 里有 `.git` 和 `CVS`。

**实测**(同一个词在四个文件里都存在):

```
命中: src/a.ts
漏掉: .gitignore   ← 被 ".git" 子串命中
漏掉: .github/ci.yml
漏掉: myCVSnotes.md ← 被 "CVS" 子串命中
```

**后果**:`.gitignore`、`.gitattributes`、`.github/workflows/*`、`.gitlab-ci.yml`
从此在 grep 里不存在,而且**静默**——返回"未找到匹配",模型会据此得出错误结论
(比如"这个项目没有 CI 配置")。这是本次改动引入的回归(原实现只有
`includes("node_modules")` 和 `includes("/.git/")`,没有这个问题)。

**修复方向**:删掉 `|| f.includes(d)`。前两个条件已经覆盖"目录在路径中间"和
"目录在路径开头"两种情况。补一条测试:`.gitignore` / `.github/x.yml` 必须能被搜到。

---

### P0-4 写工具并行化引入了并发确认框

**位置**:`src/tools/partition.ts:98-106`、`src/cli/chat.ts:434,540-556`

`buildWaves` 的规则是:两个 `file_lock` 只要 `lockPath` 互异就进**同一个 wave**
并发执行。而 `write_file`/`edit_file` 在默认状态下权限门返回 `ask`,
确认交互(`p.select`)是在 `runTool` **内部**发起的。

于是模型一轮里 `write_file(a.ts)` + `write_file(b.ts)`,两个 clack `p.select`
会同时抢同一个 TTY:提示框互相覆盖、方向键落到哪个不确定、用户的一次选择可能
被记到另一个调用上。`chat.ts:434` 那句注释"写工具按批执行,不存在多个确认框并发"
在改成 wave 模型后**已经不成立**。

同类问题:`enter_plan_mode`/`exit_plan_mode` 是 `mutates=false` → `parallel`,
会和其它只读工具同 wave,`exit_plan_mode` 的 `ctx.confirm` 也可能撞进来。

**修复方向**:把"问用户"从 handler 执行路径里提出来,变成 **wave 前的串行阶段**:

```
for (const wave of waves) {
  // 阶段 1(串行):对 wave 内每个调用跑 checkPermission,需要 ask 的逐个弹框
  // 阶段 2(并发):只对已放行的调用并发执行 handler
}
```

这样顺带解决了 `chat.ts` 里"权限确认耗时不能算进工具耗时"的重复锚定逻辑
(确认已在计时之外),也让 `tracer.approval` 的顺序和终端显示顺序一致。

保守的临时兜底(不改结构):在 `buildWaves` 里让 `file_lock` 一律独占一批,
等确认阶段拆出来之后再放开并发——但那等于放弃本次并行化的收益,只建议作为过渡。

---

## 2. P1 正确性 / 健壮性

### P1-1 快照只保留"最后一次写前"的内容,原始版本会丢

**位置**:`src/tools/snapshot.ts:41-51`

快照文件名是 `sha256(绝对路径)`,同路径重复写就覆盖。模型对一个文件连写两次
(很常见:write 之后 edit 修补),`.prev` 里剩下的是**第一次写完的中间态**,
真正的原始内容已经没了。README 承诺的"改错可 `--restore` 恢复"因此只在
"只写过一次"的情况下成立。

**修复方向**(最小改动):`.prev` 已存在则跳过,保留最早的原始版本——
"回滚"语义要的就是会话开始前的状态。

```ts
const base = this.basePath(abs);
if (await Bun.file(`${base}.prev`).exists()) return null; // 首版即原始版,不覆盖
```

若想要多版本,再加 `.<ts>.prev` 的版本链和 `listForScope` 的排序,但对学习型
harness 来说"保留首版"已经够用,且更符合直觉。

### P1-2 grep 的 30s 超时不会真的停下搜索

**位置**:`src/tools/grep.ts:118-137`

超时只是让外层 `Promise` 先 resolve 并返回错误文案,`search()` 本身没有取消机制,
仍会把整个目录树读完(`Bun.file().text()` 逐个文件)。CPU 和内存照吃,
在 `path=/` 或 home 目录这类场景下,用户看到"搜索超时"之后进程还在后台空转。

**修复方向**:改成协作式取消,在文件循环里查 deadline:

```ts
const deadline = performance.now() + SEARCH_TIMEOUT_MS;
for (const f of files) {
  if (performance.now() > deadline) { out.push("...(搜索超时,结果不完整)"); break; }
  ...
}
```

顺带把 `Promise` 竞速那一坨删掉——同一个函数里既做超时又做 catch,
现在"内部异常"和"超时"共用 `null` 返回值,报错文案是
`超时(30s)或失败`,把两种完全不同的原因糊在一起,不利于观测。

### P1-3 `contextLines` 传非数字会让命中行整个消失

**位置**:`src/tools/grep.ts:66-69`

`Math.min(5, Math.max(0, Math.floor("abc")))` = `NaN` → `start`/`end` 都是 NaN →
内层 `for (l = NaN; l <= NaN; l++)` 一次都不执行。结果是**输出了文件名冒号,
但一行命中都没有**——比报错更糟,模型会以为文件里有匹配但内容为空。

**修复方向**:

```ts
const raw = Number(args?.contextLines);
const context = Number.isFinite(raw)
  ? Math.min(MAX_CONTEXT, Math.max(0, Math.floor(raw)))
  : 0;
```

### P1-4 `bash` 的 cwd 不存在时异常逃出 handler

**位置**:`src/tools/bash.ts:74-78`(`Bun.spawn` 在 `try` 之外)

**实测**:`bash({command:"pwd", cwd:"/nope/nowhere"})` 抛
`ENOENT: no such file or directory, posix_spawn 'sh'`。靠 `chat.ts` 的外层
catch 兜住不至于崩,但:(1) 违反"工具失败返回 `错误：` 前缀"的统一约定;
(2) 报错文案指向 `sh` 找不到,极具误导性,模型会往"环境坏了"的方向自纠。

**修复方向**:把 `Bun.spawn` 挪进 `try`,并在 spawn 前显式校验:

```ts
if (args?.cwd && !existsSync(cwd)) return `错误：cwd 不存在: ${cwd}`;
```

### P1-5 超时命令的返回文案是"命令失败,退出码 143"

**位置**:`src/tools/bash.ts:80-82,107`

`proc.kill()` 让 `proc.exited` 正常 resolve(143 = SIGTERM),不会抛异常,
所以 catch 里的 `命令超时(...)被终止` 分支**不可达**。模型看到的是
"退出码 143",不知道是自己的命令太慢被 harness 掐了。

这是改动前就有的问题,但本次既然重写了这块返回路径,建议顺手修:

```ts
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeout);
...
if (timedOut) return `错误：命令超时(${timeout}ms)被终止,已输出:\n${truncate(out)}`;
```

### P1-6 `list_dir` 递归没有过滤 node_modules/.git

**位置**:`src/tools/list_dir.ts:39-48`

`MAX_ENTRIES` 是在 `readdir(path, {recursive: true})` **走完之后**才截断的,
所以"防撑爆 context"的目的达到了,"防卡死"没有:在有 node_modules 的项目里
recursive 列目录会遍历几十万条目并全部建成字符串,然后扔掉 99.9%。

**修复方向**:截断前先 filter,和 glob/grep 用同一份忽略目录常量
(建议抽到 `src/tools/ignore.ts` 供三处共用,避免像 P0-3 那样各写一份还写错):

```ts
const lines = entries
  .filter((e) => !isIgnored(join(e.parentPath ?? "", e.name)))
  .map(...);
```

### P1-7 read-before-write 门可以被"空读"绕过

**位置**:`src/tools/read_file.ts:81-91`

`ctx.fileStates.set` / `ctx.readPaths.add` 写在 `offset > total` 的错误分支
**之前**。所以 `read_file(path, offset=99999)` 一行内容都没看到,也算"读过了",
后续 `write_file` 全量覆写会直接通过。门的语义是"必须看过当前内容才能写",
这条路径破坏了它。

**修复方向**:把这两行挪到成功返回路径上(`end`/`slice` 算完之后)。
更严格的版本可以记录"读过哪些行区间",覆写整文件时要求读过全文,
但对学习型 harness 来说挪位置就够了。

### P1-8 `looksBinary` 在全量解码之后才判,且可能漏判

**位置**:`src/tools/read_file.ts:14-25,70-73`

`await Bun.file(path).text()` 已经把整个文件读进内存并按 UTF-8 有损解码了,
之后才判二进制——(1) 大二进制文件的内存代价一点没省;
(2) `text()` 把无效字节替换成 `U+FFFD`(charCode 65533,不小于 32),
所以"不含 NUL 但无效字节很多"的文件(部分压缩/图片格式)可能被判成文本。

**修复方向**:按字节判,读头部即可:

```ts
const head = await Bun.file(path).slice(0, BINARY_SCAN).bytes();
// head.includes(0) || 非打印字节占比 > 0.3
```

同时可以顺手加一条文件大小护栏(`file.size > N` 直接建议用 grep/分页),
现在 `read_file` 对 500MB 文件仍会先整个 `text()`。

### P1-9 `snapshot.restore` 不检查 `.prev` 是否存在

**位置**:`src/tools/snapshot.ts:100`

只校验了 `.meta.json`,直接 `await Bun.file(`${base}.prev`).text()`。
meta 在而 `.prev` 被手动删/写盘中断时,抛未捕获异常把 `--restore` 打崩
(`restoreCmd` 没有 try)。

**修复方向**:同样先 `exists()`,返回 `{ok:false, error:"快照内容文件缺失"}`;
`restoreCmd` 外面再包一层 try 兜底,CLI 不应该抛栈给用户。

### P1-10 tmp 落盘和 snapshots 都没有清理策略

**位置**:`src/tools/bash.ts:100-102`(`bash-${Date.now()}.out`)、
`src/config/paths.ts` 的 `tmpDir()`/`snapshotDir()`

每次大输出落一个文件,每个会话落一批快照,都只写不删。`~/.coderig/` 会无限增长,
而且里面是用户源码的历史副本(隐私面也值得考虑)。

**修复方向**:启动时做一次惰性 GC——`tmp/` 删掉 mtime 超过 24h 的,
`snapshots/` 保留最近 N 个 cid(比如 20)。放在 `startChat` 开头 fire-and-forget
即可,不必阻塞。另外 `--snapshots` 的输出里可以提示占用空间。

---

## 3. P2 设计层面

### P2-1 "总是允许(写入配置)"的授权粒度太粗

**位置**:`src/cli/chat.ts:445-450,466-471`、`src/config/settings.ts:addPermission`

持久化的是**工具名**。用户对一条 `bun test` 点了"总是允许",
写进 `settings.json` 的是 `bash`——从此**所有会话**里**所有非 dangerous 命令**
永久免问(`permissions.ts:142` 命中 `sessionAllows.has("bash")` 直接 auto)。
一次点击换来的授权范围远超用户在那一刻的预期,而 UI 文案完全没提示这一点。

对照:Claude Code 持久化的是命令前缀/路径模式级规则,不是工具级。

**修复方向**(按代价排序):

1. 最小:`bash` 不提供"总是允许"选项(只给"本会话不再询问"),
   `write_file`/`edit_file` 保留——文件写至少还有快照兜底。
2. 中等:持久化 `bash:<第一个 token>`(如 `bash:bun`),`checkPermission`
   里按前缀匹配。规则语法一升级,`settings.json` 的 schema 就得往
   `{tool, pattern}` 走,顺便为将来的路径规则留位置。
3. 至少把文案改成"总是允许 **所有** bash 命令(写入配置,跨会话生效)",
   让范围显式。

### P2-2 每轮把运行时状态拼进 system prompt 会打掉上下文缓存

**位置**:`src/cli/chat.ts:170-175`、`src/prompts/system.ts:resolveSystemPrompt`

`[运行时状态]`(模式 + todo 清单)被拼在 system prompt **末尾**,而 system 是
整个请求的最前缀。todo 每更新一次、模式每切一次,system 就变,
DeepSeek 的上下文缓存从第一个 token 起全部 miss。todo 工具的使用频率恰恰很高,
等于把缓存命中率打到接近 0,成本和首 token 延迟都实打实变差。

**修复方向**:静态 system 保持不变,把 `[运行时状态]` 作为**消息尾部**的一条
消息注入(role 用 user 或 system 都行,内容标注 `[运行时状态]` 保持可区分)。
效果等价(模型同样每轮看到),但前缀稳定 → 缓存照常命中。

实现上是 `sendMessages` 的 `opts.runtime` 从"拼进 sys"改成"append 到 messages
末尾",`chat.ts` 侧不用动。注意别写进 `history` 的持久转录——它是每轮重建的
投影,不是对话内容。

### P2-3 PROMPT_VERSION 一次跳两版,A/B 无法归因

**位置**:`src/prompts/system.ts:1-16`

v4 → v6 一次性捆了:todo 工具纪律 + grep 纪律强化(v5 的内容)、
分段架构、plan 模式 + workflow 二选一、运行时状态注入、压缩提示词结构化。
按 CLAUDE.md 第 6 条("固定一组任务,两组各跑一遍"),这样跑出来的 trace
无法回答"是哪一项带来的变化"——而这个仓库现在正处在 sysprompt A/B 阶段,
归因能力是主要产出。

**修复方向**:拆成两次可对比的发布:

- v5:分段架构 + todo/grep 纪律(纯静态提示词变化,不改协议面)
- v6:plan 模式 + 运行时状态注入(引入动态段,需要单独看它对缓存/行为的影响)

`compact.ts` 的摘要模板变化其实是独立维度(它走 `noSystemPrompt` 的辅助调用),
建议在 trace 里单独标一个字段而不是混进 PROMPT_VERSION。

### P2-4 normal workflow 里没有"何时进 plan 模式"的指引

**位置**:`src/prompts/system.ts:NORMAL_WORKFLOW`

`enter_plan_mode` 的适用条件只写在工具描述里。工具描述在多数实现里权重低于
system prompt 的流程段,模型大概率永远不会主动进规划模式,
这个新增能力等于白做(何况 P0-1 让它现在必然失败)。

**修复方向**:在 `NORMAL_WORKFLOW` 加一条,和 todo 的分工写清楚——
"改动涉及 3 个以上文件或有不可逆风险时,先 `enter_plan_mode` 调研并提交计划;
单文件小改直接做"。

### P2-5 `compact.ts` 的结构化模板标签不闭合

**位置**:`src/history/compact.ts:16-22`

外层有 `<state_snapshot>`/`</state_snapshot>`,内层五个
(`<overall_goal>` 等)全是**只有开标签**。模型面对半闭合的伪 XML,
输出结构会随机漂(有的补闭合、有的当标题、有的忽略),
后续想解析这份摘要就没法可靠地解析。

**修复方向**:要么写成完整闭合的 XML(附一个 1-2 行的示例),
要么干脆用 Markdown 小标题(`## 目标` / `## 约束` …)——
本项目的摘要只给模型读、不做程序解析,Markdown 更省 token 也更稳。

### P2-6 `detectProjectType()` 每轮被调两次

**位置**:`src/prompts/system.ts:62,87`

`baseIdentity()` 和 `verification()` 各调一次,每次都跑一串 `existsSync`。
一次运行内项目类型不会变。

**修复方向**:模块级 memoize(`let cached: string | undefined`)。
注意别写成模块顶层常量——按 CLAUDE.md 第 5 条,那会在 import 时冻结
`process.cwd()`/env,测试里覆盖不掉。

### P2-7 `FileLocks` 在当前调用路径上是纯冗余

**位置**:`src/tools/partition.ts:118-128`、`src/cli/chat.ts:544-552`

`buildWaves` 已经保证同一个 wave 内 `lockPath` 互异,所以 `withLock` 永远
拿不到已占用的锁,一次都不会真正串行化。留着作为第二道保险没坏处,
但注释现在写的是"chat.ts 用它对 write/edit 做同文件串行"——会让后来的人
以为并发安全靠锁,从而放心地去改 `buildWaves`。

**修复方向**:注释改成"防御性冗余:并发安全由 buildWaves 保证,
这里是第二道保险,便于将来放宽 wave 规则";或者删掉 `FileLocks`,
让不变量只有一处(我倾向留着 + 改注释,成本更低)。

### P2-8 零散清理

- `src/cli/chat.ts:170`:`listDefs(denyTools.size ? denyTools : undefined)`
  的三元多余,`listDefs` 内部 `hidden?.has(...)` 已经处理空集。
- `src/cli/snapshot_cmd.ts:22`:`new SnapshotStore(snapshotDir(), cid ?? "")`
  在不带 cid 时传空 scope 占位,而 `listForScope`/`restore` 都显式收 scope 参数。
  建议把 scope 从构造器移出、或给 store 加一个静态列举入口,消掉这个空串。
- `src/config/settings.ts:saveSettings`:`await import("node:fs/promises")`
  写在函数体内做动态 import,没有理由(chmod 不是可选依赖),
  提到文件顶层的静态 import 更一致。
- `settings.permissions.deny` 若被填成 `read_file`,工具从模型可见列表消失,
  但 sysprompt 仍要求"改文件前必须先 read_file"、门也仍要求读过才能写 →
  写操作永久死锁。建议 `loadSettings` 对 deny 掉核心只读工具的情况打一条警告,
  或在门的错误文案里区分"工具被禁用"这种情况。
- `permissions.ts` 的 `denyTools` 参数与 `listDefs(hidden)` 的隐藏是两条独立
  实现同一策略的路径(deny 的工具既隐藏又硬禁)。当前是有意的双保险,
  但值得在 `settings.ts` 的头注释里点明"两处都要改",否则以后加
  `deny` 的新语义(如按参数 deny)容易只改一处。

---

## 4. 测试覆盖缺口

现有 97 个测试全绿,却漏掉了上面 4 个 P0。缺口是有规律的:

| 缺口 | 对应缺陷 | 建议补的用例 |
|---|---|---|
| `ctx.confirm` 只测了默认的"永远批准" | P0-2 | confirm 返回 false 时 mode 必须留在 plan |
| plan 守卫的路径判定没有端到端测试 | P0-1 | 给定 `plans/x.md` 与 `plansDir()/x.md`,断言守卫结果 |
| grep 的忽略过滤只测了 node_modules | P0-3 | `.gitignore` / `.github/x.yml` 必须命中 |
| `buildWaves` 只测了分组结果,没测"同 wave 是否会并发触发交互" | P0-4 | 拆出确认阶段后,断言 ask 类调用被串行询问 |
| 边界值(NaN/非法参数)基本没测 | P1-3 | `contextLines: "abc"`、`offset` 超界、`cwd` 不存在 |
| 快照的"写两次"场景没测 | P1-1 | 连续两次 snapshot 后 `.prev` 必须是最初内容 |

---

## 5. 建议的修复顺序

**第一批(P0,改动都很小,建议一次提交)**

1. `chat.ts:69` confirm 取反逻辑 — 3 行
2. `grep.ts:63` 删掉 `f.includes(d)` — 1 行
3. plan 指令面注入 `plansDir()` 绝对路径,并把 bash 纳入 plan 守卫 — 约 15 行
4. 权限确认阶段从 handler 里提出来,放到 wave 执行之前 — 约 40 行(结构性,单独提交)

**第二批(P1 正确性)**

5. read_file 空读绕门(挪两行)、二进制按字节判
6. grep 协作式超时取消 + `contextLines` NaN 兜底
7. list_dir 过滤忽略目录(顺手把忽略常量抽到共用模块,三处共用)
8. bash cwd 校验 + 超时标志
9. 快照保留首版 + restore 的 `.prev` 存在性检查

**第三批(P2 设计,值得单独讨论后再动)**

10. 运行时状态从 system prompt 挪到消息尾部(缓存收益最大的一项)
11. 持久化权限的粒度收窄 + 文案改准确
12. PROMPT_VERSION 拆成 v5/v6 两次可对比发布
13. compact 模板闭合、detectProjectType memoize、零散清理

第一批修完 plan 模式和 grep 才算真正可用;第三批第 10 项虽然是 P2,
但对每轮请求成本影响最直接,建议不要拖太久。
