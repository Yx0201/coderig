// ===== App 根:Static 历史(回卷) + 固定底部条 + 模态/输入 =====
//
// chat.ts(命令式)往 TuiStore append;这里 useSyncExternalStore 订阅,version 一 bump
// 就重绘。已落定块走 <Static>(写一次、推进回卷、App 钉底部);live 流式区在底部增量;
// 交互(promptInput/select/confirm)走模态 —— 这里的 useInput 统一接键盘并分发给模态。

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Static, Box, Text, useApp, useInput } from "ink";
import spinners from "cli-spinners";
import type { TuiStore, Activity } from "./store.ts";
import { BlockView } from "./blocks.tsx";
import { ModalOverlay } from "./modal.tsx";
import { tailLines } from "./layout.ts";
import { termWidth } from "./width.ts";

// live 区最多占几行:底部是固定条,长流不能把输入行顶出屏幕(完整内容落定后进回卷可上滚)
const LIVE_REASONING_LINES = 4;
const LIVE_CONTENT_LINES = 10;

// 回车判定:Ink 只把 '\r' 认成 key.return('\n' 被它记成 name='enter',return 标志是 false)。
// 真终端敲回车发 '\r' 没问题,但管道/pty 会把"整段文本 + 尾部 \n"一次灌进来,
// 那时 key.return 为 false、换行藏在 input 里,永远提交不了。harness 侧的健壮性问题,两种都接。
function submitIndex(input: string, key: { return: boolean }): number {
  const nl = input.search(/[\r\n]/);
  if (nl >= 0) return nl;
  return key.return ? 0 : -1;
}

export function App({ store }: { store: TuiStore }) {
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot);
  void version;

  const storeRef = useRef(store);
  storeRef.current = store;
  const { exit } = useApp();

  // ===== 全局键盘:分发给当前模态(text=单行输入,select=选项) =====
  useInput((input, key) => {
    const s = storeRef.current;
    const modal = s.getModal();
    if (key.ctrl && input.toLowerCase() === "c") {
      if (modal) {
        s.cancelModal(); // 模态里 Ctrl+C = 取消,交回 chat.ts 走正常收尾(汇总 + Bey~)
        return;
      }
      // 模型忙、没有模态:Ink 的 exitOnCtrlC 被关掉了(见 mount.tsx),这里自己退。
      // 先卸载恢复终端(raw mode / 光标),再让进程结束 —— 与线性模式下流式中 Ctrl+C 一致
      s.deactivate();
      exit();
      setTimeout(() => process.exit(130), 10);
      return;
    }
    if (!modal) return; // 非交互等待:忽略按键(模型忙时不抢输入)
    // Esc = 取消:模态自己写着"Esc 取消",之前没接这个键(按了没反应)
    if (key.escape) {
      s.cancelModal();
      return;
    }
    if (modal.kind === "text") {
      const nl = submitIndex(input, key);
      if (nl >= 0) {
        // 换行前的部分算这一行的内容(粘贴一整行的情形);换行之后的残余丢弃 —— 单行输入框
        s.resolveModal((modal.buffer ?? "") + input.slice(0, nl));
        return;
      }
      // macOS 的删除键在不同终端里可能报 backspace 或 delete,两个都接
      if (key.backspace || key.delete) {
        modal.buffer = (modal.buffer ?? "").slice(0, -1);
        s.refreshModal();
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        modal.buffer = (modal.buffer ?? "") + input;
        s.refreshModal();
        return;
      }
    } else {
      const n = modal.options?.length ?? 0;
      if (n === 0) return; // 防 % 0 = NaN
      if (key.upArrow || key.downArrow) {
        const d = key.downArrow ? 1 : -1;
        modal.cursorInd = (modal.cursorInd + d + n) % n;
        s.refreshModal();
        return;
      }
      if (submitIndex(input, key) >= 0) {
        const opt = modal.options?.[modal.cursorInd];
        if (opt) s.resolveModal(opt.value);
        return;
      }
    }
  });

  const blocks = store.getBlocks();
  const live = store.getLive();
  const status = store.getStatus();
  const modal = store.getModal();
  const activity = store.getActivity();
  const width = termWidth();

  return (
    <>
      {/* 已落定历史块:<Static> 写一次、推进回卷,Ink 维持底部 App 位置 */}
      <Static items={blocks}>
        {(b, i) => <BlockView key={i} block={b} />}
      </Static>

      {/* 固定底部条:header 与输入用 flexShrink=0 保持不被压缩;live 区自己限行数
          (只画最近若干行,完整内容落定后进 Static 回卷,原生可上滚看全) */}
      <Box flexDirection="column">
        <Box flexShrink={0}>
          <HeaderBox model={status.model} prompt={status.prompt} completion={status.completion} />
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          {live.reasoning ? (
            <Text dimColor>
              {tailLines(live.reasoning, width, LIVE_REASONING_LINES).join("\n")}
            </Text>
          ) : null}
          {live.content ? (
            <Text>{tailLines(live.content, width, LIVE_CONTENT_LINES).join("\n")}</Text>
          ) : null}
        </Box>
        <Box flexShrink={0}>
          <ActivityLine activity={activity} />
        </Box>
        {/* 输入位:正常等输入时是 text 模态(见 TuiTerm.promptInput),
            模型忙时没有模态 —— 那行由上面的活动行占着,这里不再画多余的提示符 */}
        {modal ? (
          <Box flexShrink={0}>
            <ModalOverlay store={store} />
          </Box>
        ) : null}
      </Box>
    </>
  );
}

// ===== 活动行:转圈 + 在干什么 + 已耗时 =====
//
// 之前"思考"只有一条静态的 🤔 行,没有任何动感 —— 长思考时看不出程序是活着还是卡死。
// 这里用 cli-spinners 的帧序列 + 自己的定时器驱动重绘(store 里没有时间,时间在这)。
// 注意:idle 时必须停表,否则空闲状态下每 80ms 一次 setState = 白烧 CPU 还闪屏。
const LABEL: Record<Activity["kind"], string> = {
  idle: "",
  waiting: "等待模型响应",
  thinking: "思考中",
  answering: "回答中",
  tool_args: "生成工具参数",
  tool_run: "工具执行中",
};

function ActivityLine({ activity }: { activity: Activity }) {
  const busy = activity.kind !== "idle";
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), spinners.dots.interval);
    return () => clearInterval(id);
  }, [busy]);

  if (!busy) return <Text> </Text>; // 占位一行,免得 idle/busy 切换时底部条高度跳动

  const frames = spinners.dots.frames;
  const frame = frames[tick % frames.length]!;
  const label = LABEL[activity.kind];
  const sec = activity.startedAt ? ((Date.now() - activity.startedAt) / 1000).toFixed(1) : "0.0";
  const detail = activity.label ? ` ${activity.label}` : "";
  const chars = activity.chars !== undefined ? ` · ${activity.chars} 字符` : "";
  return (
    <Text color="cyan">
      {frame}{" "}
      <Text dimColor>
        {label}
        {detail}
        {chars} · {sec}s
      </Text>
    </Text>
  );
}

function HeaderBox({
  model,
  prompt,
  completion,
}: {
  model: string;
  prompt: number;
  completion: number;
}) {
  return (
    <Box>
      <Text color="cyan">● coderig</Text>
      <Text dimColor>  ·  model: {model !== "" ? model : "?"}</Text>
      {prompt > 0 || completion > 0 ? (
        <Text dimColor>  ·  token ↑{prompt} ↓{completion}</Text>
      ) : null}
    </Box>
  );
}
