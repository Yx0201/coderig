// ===== 启动 Ink 应用:挂到 TuiStore 上 =====
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";
import type { TuiStore } from "./store.ts";

export function startTui(store: TuiStore) {
  // exitOnCtrlC 必须关:开着的话 Ctrl+C 会让 Ink 先自己卸载,而 chat.ts 还要在
  // "取消"之后写 session 汇总和 Bey~ —— 那些行就写进了已经死掉的帧里(实测 pty 下丢失)。
  // Ctrl+C 由 app.tsx 的 useInput 统一处理:有模态=取消输入,没模态=卸载后退出。
  const instance = render(<App store={store} />, { exitOnCtrlC: false });
  return {
    // 同步返回首个已渲染帧(测试/编排用)
    instance,
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  };
}