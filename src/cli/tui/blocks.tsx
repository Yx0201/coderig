// ===== StaticBlock 渲染:把一条"已落定的块"画成 Ink Text =====
//
// 放进 <Static items>,渲染一次后上滚进回卷。这里用 Ink Text 的 color/bold 等受控
// 样式 + 把 ANSI markdown(renderMarkdown 产出)授权给 Text —— 实测 Ink 会把宽字节
// 的 ANSI SGR 序列透传并以格子宽测量,所以 <Static> 里能放已着色的 markdown。

import React from "react";
import { Box, Text } from "ink";
import type { StaticBlock } from "./store.ts";
import { renderMarkdown } from "./markdown.ts";
import { truncateToWidth } from "./layout.ts";
import { termWidth } from "./width.ts";

// 工具卡片最多展示几行结果:更多的在 trace.jsonl 里,屏幕上只要"发生了什么"
const TOOL_RESULT_LINES = 3;

export function BlockView({ block }: { block: StaticBlock }) {
  switch (block.kind) {
    // 用户提问 / 模型回答前空一行:工具卡片与 notice 连成一片时,一问一答的边界靠它分开
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>▶ {block.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>{renderMarkdown(block.markdown)}</Text>
        </Box>
      );
    case "thinking":
      return (
        <Text dimColor>
          🤔 {block.header}
          {block.folded ? "" : `\n${block.body}`}
        </Text>
      );
    case "tool":
      return (
        <ToolCardBlock
          name={block.name}
          result={block.result}
          ok={block.ok}
          duration={block.duration}
        />
      );
    case "notice":
      // 无色 = 灰(默认的"一次性提示");带色的照 chat.ts 的语义上色(⛔ 阻止是红的)
      return block.color && block.color !== "dim" ? (
        <Text color={block.color}>{block.text}</Text>
      ) : (
        <Text dimColor>{block.text}</Text>
      );
  }
}

// 工具卡片:一行"工具名 · 耗时",下面最多 3 行结果摘要。
// 刻意不显示参数——参数原文进 trace.jsonl,屏幕上一行 JSON 会把结果挤出视野。
function ToolCardBlock({
  name,
  result,
  ok,
  duration,
}: {
  name: string;
  result: string;
  ok: boolean;
  duration: number;
}) {
  const width = termWidth();
  const lines = result
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  const shown = lines.slice(0, TOOL_RESULT_LINES);
  const rest = lines.length - shown.length;
  return (
    <Text>
      <Text color={ok ? "green" : "red"}>{ok ? "🔧" : "✗"} </Text>
      <Text bold>{name}</Text>
      <Text dimColor> · {duration}ms</Text>
      {shown.map((l, i) => (
        <Text key={i} dimColor>
          {"\n"}   {truncateToWidth(l, width - 4)}
        </Text>
      ))}
      {rest > 0 ? <Text dimColor>{"\n"}   …(+{rest} 行)</Text> : null}
    </Text>
  );
}
