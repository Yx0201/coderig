// ===== SessionContext:工具 handler 的会话级状态 =====
//
// 工具原本是纯函数 (args) => string,但冲突检测、read-before-write、todo 状态、
// 改动快照都需要"跨调用的会话记忆",纯函数给不了。做法是给每个 handler 注入
// 一个 ctx,承载该会话的工具侧状态(chat.ts 每会话建一个,循环里透传)。
//
// 关键语义 —— fileStates 记录"会话最后一次知道的内容指纹"(sha256):
//   - read_file 读到即更新 → 之后 edit 拿它比对,能发现"文件被外部改过";
//   - write_file/edit_file 写成功也更新 → 连续编辑同一文件不会误判冲突。
//   所以 fileStates 不是"磁盘上是什么",而是"会话认为文件是什么"——
//   on-disk 指纹 ≠ 会话已知指纹 → 说明有人(用户/其它进程/bash)改过,拦截。

export interface FileState {
  hash: string; // 会话最后一次读/写该文件时的内容 sha256
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// agent 当前模式:normal=正常可读写,plan=规划模式(只读 + 只能写计划文件)。
// 模式驱动 sysprompt 的 workflow 段二选一(见 prompts/system.ts)与 plan 写守卫
export type AgentMode = "normal" | "plan";

// gate 拦截的种类:read-before-write=没读过就写,conflict=读后被外部改过
export type GateKind = "read_before_write" | "conflict";

export interface ToolContext {
  fileStates: Map<string, FileState>; // path → 会话已知指纹
  readPaths: Set<string>; // 会话内读过的 path(read-before-write 门用)
  todos: TodoItem[]; // todo 工具状态(整体替换语义)
  // 共享可变状态对象:handler 改 mode(如 enter_plan_mode)必须传回 chat.ts,
  // 而 runTool 会对 ctx 做浅拷贝——原始值属性(mode 是 string)改不到拷贝上,
  // 放对象引用里才能传播(参考 D1 决策)
  state: { mode: AgentMode };
  // 审批 UI 钩子:exit_plan_mode 提交计划时调用,chat.ts 注入 p.confirm。
  // handler 不直接碰 UI(可测试),返回 true=批准 / false=拒绝
  confirm: (message: string) => Promise<boolean>;
  // 写前快照钩子:由 chat.ts 注入,handler 在写文件前调用。
  // 放 ctx 而不是 handler 直接 import snapshot 模块,是为了保持"工具不碰
  // 落盘细节、可测试"——测试传假的 snapshot 函数即可。
  // 返回 Promise<unknown>:handler 只 await 不关心结果(留底是否成功不影响写入)
  snapshot: (path: string) => Promise<unknown>;
  // 观测钩子:门被触发时调用,chat.ts 据此落 tool_gate trace 事件。
  // 同样走注入,工具层不直接 import tracer(遵守 CLAUDE.md 观测约定)
  gate: (info: { kind: GateKind; path: string }) => void;
}

// 建一个空的会话上下文。snapshot/gate/confirm 由 chat.ts 注入真实实现
// (SnapshotStore + tracer + p.confirm),测试传自己的 fake 或直接不传
// (默认 no-op / 默认批准,避免未接线时报错)
export function createSessionContext(scope?: {
  snapshot?: ToolContext["snapshot"];
  gate?: ToolContext["gate"];
  confirm?: ToolContext["confirm"];
}): ToolContext {
  const gate = scope?.gate ?? (() => {});
  const snapshot =
    scope?.snapshot ??
    (async () => {
      /* 未接线:默认 no-op */
    });
  const confirm = scope?.confirm ?? (async () => true); // 默认批准,测试友好
  return {
    fileStates: new Map(),
    readPaths: new Set(),
    todos: [],
    state: { mode: "normal" },
    confirm,
    snapshot,
    gate,
  };
}
