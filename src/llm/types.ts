export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
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
    delta?: { content?: string; role?: Role,reasoning?: string };
  }[];
  [k: string]: any; // 允许其它字段
}


  export type StreamEvent =
    | { type: "reasoning"; text: string }
    | { type: "content"; text: string };