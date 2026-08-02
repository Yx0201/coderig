// ===== 模态渲染:把 store 里的当前模态画出来 =====
//
// select:选项列表,↑↓ 高亮、回车确认(右下角提示)
// text :单行输入,尾部光标,回车提交
// 键盘由 App 里的 useInput 统一处理(见 app.tsx),这里只负责"画"。

import React from "react";
import { Box, Text } from "ink";
import type { TuiStore } from "./store.ts";

export function ModalOverlay({ store }: { store: TuiStore }) {
  const modal = store.getModal();
  if (!modal) return null;

  if (modal.kind === "text") {
    return <TextInput value={modal.buffer ?? ""} />;
  }

  // select / confirm(confirm 就是带 是/否 的 select)
  const options = modal.options ?? [];
  const ind = Math.min(modal.cursorInd, Math.max(0, options.length - 1));
  return (
    <Box flexDirection="column">
      <Text dimColor>{modal.title}</Text>
      {options.map((o, i) => (
        <Text key={i} color={i === ind ? "cyan" : undefined} bold={i === ind}>
          {i === ind ? "❯ " : "  "}
          {o.label}
        </Text>
      ))}
      <Text dimColor>↑↓ 选择 · 回车确认 · Esc 取消</Text>
    </Box>
  );
}

function TextInput({ value }: { value: string }) {
  return (
    <Box>
      <Text color="green">&gt; </Text>
      <Text>{value}</Text>
      {/* dimColor 而不是 color="dim":dim 是样式修饰不是颜色名,Ink 会当无效颜色静默丢掉 */}
      <Text dimColor>▍</Text>
    </Box>
  );
}