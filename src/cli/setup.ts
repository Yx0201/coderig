import * as p from "@clack/prompts";
import type { Config } from "../config/index.ts";
import { saveConfig } from "../config/index.ts";

// ===== 首次运行配置向导 =====
//
// 检测到 ~/.coderig/config.json 不存在或缺关键字段时,交互式引导用户填配置。
// 用 @clack/prompts(已是依赖,chat.ts 在用),不引入新依赖。

// provider 预设:把 baseUrl/endpoint/默认模型/窗口大小打包好,用户只需要粘 key
const PROVIDERS = [
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    endpoint: "/chat/completions",
    model: "deepseek-v4-flash",
    contextWindowTokens: 1_000_000,
    // 官方上限 384K,但不顶格:压缩阈值 80% → prompt 最多 800k,
    // 顶格会让 prompt+max_tokens 越过 1M 窗口。32768 保持不变量
    maxOutputTokens: 32768,
  },
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    endpoint: "/chat/completions",
    model: "gpt-5",
    contextWindowTokens: 400_000,
    maxOutputTokens: 32768,
  },
  {
    name: "自定义(OpenAI 兼容)",
    baseUrl: "",
    endpoint: "/chat/completions",
    model: "",
    contextWindowTokens: 128_000,
    maxOutputTokens: 16384,
  },
];

export async function runSetup(): Promise<Config> {
  p.intro("◆  没有找到配置,来做一次初始化");

  const providerChoice = await p.select({
    message: "选择 provider",
    options: PROVIDERS.map((p, i) => ({
      value: i,
      label: p.name,
    })),
  });
  if (p.isCancel(providerChoice)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const preset = PROVIDERS[providerChoice as number]!;

  // 自定义 provider 需要用户填 baseUrl;预设的直接用
  let baseUrl = preset.baseUrl;
  if (!baseUrl) {
    const input = await p.text({
      message: "Base URL(如 https://api.example.com/v1)",
      placeholder: "https://...",
    });
    if (p.isCancel(input)) {
      p.cancel("已取消");
      process.exit(0);
    }
    baseUrl = input as string;
  }

  const apiKey = await p.password({
    message: "粘贴 API Key",
  });
  if (p.isCancel(apiKey)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const model = await p.text({
    message: "模型名称",
    placeholder: preset.model,
    defaultValue: preset.model,
  });
  if (p.isCancel(model)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const cfg: Config = {
    baseUrl,
    endpoint: preset.endpoint,
    apiKey: apiKey as string,
    model: (model as string) || preset.model,
    contextWindowTokens: preset.contextWindowTokens,
    maxOutputTokens: preset.maxOutputTokens,
  };

  await saveConfig(cfg);
  p.outro(`✓ 已写入 ~/.coderig/config.json`);

  return cfg;
}
