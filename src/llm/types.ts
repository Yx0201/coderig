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
      reasoning?: string;
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
