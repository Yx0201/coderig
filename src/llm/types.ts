export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[]; // 仅 assistant 调工具时存在
  tool_call_id?: string; // 仅 tool 角色消息存在，对上哪次调用
  name?: string; // 仅 tool 角色消息，标记是哪个工具产的结果
  // 仅 assistant 消息:DeepSeek thinking 模式的推理原文。
  // DeepSeek 硬约束——带 tool_calls 的 assistant 消息必须在后续所有请求里
  // 完整回传 reasoning_content,否则 API 直接 400
  // ("The 'reasoning_content' in the thinking mode must be passed back to the API")。
  // 无 tool_calls 的普通回答轮则不必存:传了也会被 API 忽略,存了只会胀大转录
  reasoning_content?: string;
}

export interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  system_fingerprint?: string;
  choices?: {
    index: number;
    finish_reason: string | null;
    delta?: {
      content?: string;
      role?: Role;
      reasoning_content?: string; // DeepSeek thinking 模式的推理流(官方字段名)
      tool_calls?: {
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  // 带 stream_options.include_usage 时，最后一个 chunk 的 choices 为空数组、
  // 只携带 usage 字段（其余字段仍存在）
  usage?: TokenUsage;
  [k: string]: any; // 允许其它字段
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_calls"; tool_calls: ToolCall[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; finish_reason: string | null } // 本轮 finish_reason(stop/tool_calls/length/null),判停兜底用
  // 工具参数流式生成中的进度(节流:每 512 字符或首次知名一次)。
  // write_file 的 content 是整文件全文,生成十几秒期间若无任何输出,用户会以为卡死
  | { type: "tool_call_progress"; name?: string; argsChars: number }
  // 请求级重试:429/5xx/网络错误时,sendMessages 在重发前 yield 一次。
  // 底层不直接碰 tracer(CLAUDE.md 观测约定),重试事实顺管道流到 chat.ts 再落盘
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "raw"; data: string }; // 本轮所有 SSE 的原始 data(JSON.parse 前),诊断 LLM 实际输出用

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object; // JSON Schema
  };
}

export type ToolHandler = (args: any) => string | Promise<string>;
