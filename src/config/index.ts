import { configPath } from "./paths.ts";

// ===== 配置层 =====
//
// 优先级:环境变量 > ~/.coderig/config.json > 首次运行向导。
// 环境变量必须最优先——CI 和你自己的 A/B 实验要能随时覆盖用户配置文件里的值,
// 否则每次跑实验都得手动改 config.json。
//
// 关键设计:loadConfig 是 async 的(读文件),但 getConfig 是同步的。
// 入口(index.ts)在启动时先 await loadConfig,然后 setConfig 注入,
// 之后所有模块通过 getConfig() 同步取配置——不需要每个函数都 async。

export interface Config {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

// 内存里的当前配置。null = 尚未初始化(还没跑 loadConfig/setConfig)
let current: Config | null = null;

// 从环境变量 + 配置文件合并出一份完整配置。不完整(缺 apiKey/model)返回 null,
// 调用方(入口)据此决定要不要跑首次配置向导
export async function loadConfig(): Promise<Config | null> {
  const file = Bun.file(configPath());
  const fileCfg: Partial<Config> = (await file.exists())
    ? await file.json()
    : {};

  // 环境变量优先,逐项覆盖文件里的值
  const baseUrl = process.env.BASE_URL || fileCfg.baseUrl || "";
  const endpoint = process.env.ENDPOINT || fileCfg.endpoint || "";
  const apiKey = process.env.API_KEY || fileCfg.apiKey || "";
  const model = process.env.MODEL || fileCfg.model || "";
  const contextWindowTokens = Number(
    process.env.CONTEXT_WINDOW_TOKENS ||
      fileCfg.contextWindowTokens ||
      1_000_000,
  );
  const maxOutputTokens = Number(
    process.env.MAX_OUTPUT_TOKENS || fileCfg.maxOutputTokens || 32768,
  );

  // 缺关键字段 = 不完整,需要向导
  if (!apiKey || !model || !baseUrl) return null;

  return { baseUrl, endpoint, apiKey, model, contextWindowTokens, maxOutputTokens };
}

// 写配置到 ~/.coderig/config.json,chmod 0600(明文 API key,不能让别人读)
export async function saveConfig(cfg: Config): Promise<void> {
  await Bun.write(configPath(), JSON.stringify(cfg, null, 2) + "\n");
  // chmod 0600:配置里有明文 API key,权限必须收紧
  const { chmod } = await import("node:fs/promises");
  await chmod(configPath(), 0o600);
}

// 注入配置(入口在 import 链之前调,之后所有模块同步取用)
export function setConfig(cfg: Config): void {
  current = cfg;
}

// 取当前配置。没初始化就抛——这说明入口忘了先 loadConfig+setConfig,
// 是编程错误,不是运行时状况,应该 crash 出来让开发者看到
export function getConfig(): Config {
  if (!current) {
    throw new Error(
      "配置未初始化:入口必须先 await loadConfig() 再 setConfig()",
    );
  }
  return current;
}
