import * as p from "@clack/prompts";
import type { Config } from "../config/index.ts";
import { saveConfig } from "../config/index.ts";

// ===== 首次运行配置向导 =====
//
// 检测到 ~/.coderig/config.json 不存在或缺关键字段时,交互式引导用户填配置。
// 只支持 DeepSeek 云端 API(2026-07-29 起项目唯一 backend),不再提供 OpenAI /
// 自定义 provider——这是学习项目,backend 是固定的实验环境,不是可配置项。
// 模型同样固定 deepseek-v4-flash,不给选择:换模型靠环境变量 MODEL 覆盖(见
// config/index.ts 的优先级),不该在向导里暴露。
//
// 用 @clack/prompts(已是依赖,chat.ts 在用),不引入新依赖。

// DeepSeek 固定预设:baseUrl/endpoint/模型/窗口大小打包好,用户只需要粘 key
const DEEPSEEK = {
  baseUrl: "https://api.deepseek.com",
  endpoint: "/chat/completions",
  model: "deepseek-v4-flash",
  contextWindowTokens: 1_000_000,
  // 官方上限 384K,但不顶格:压缩阈值 80% → prompt 最多 800k,
  // 顶格会让 prompt+max_tokens 越过 1M 窗口。32768 保持不变量
  maxOutputTokens: 32768,
};

export async function runSetup(): Promise<Config> {
  p.intro("◆  没有找到配置,来做一次初始化");

  const apiKey = await p.password({
    message: "粘贴 DeepSeek API Key",
  });
  if (p.isCancel(apiKey)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const cfg: Config = {
    baseUrl: DEEPSEEK.baseUrl,
    endpoint: DEEPSEEK.endpoint,
    apiKey: apiKey as string,
    model: DEEPSEEK.model,
    contextWindowTokens: DEEPSEEK.contextWindowTokens,
    maxOutputTokens: DEEPSEEK.maxOutputTokens,
  };

  await saveConfig(cfg);
  p.outro(`✓ 已写入 ~/.coderig/config.json`);

  return cfg;
}
