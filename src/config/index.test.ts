import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, getConfig, setConfig } from "./index.ts";

// 配置层的关键行为:
// 1. 优先级 env > file > null(不完整)
// 2. saveConfig 写出的文件权限是 0600(明文 API key 不能让别人读)
// configPath() 是惰性函数,测试里改 CODERIG_HOME 立即生效(见 paths.ts)

describe("config/index", () => {
  test("loadConfig 环境变量优先于配置文件", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "coderig-test-"));
    await Bun.write(
      join(tmp, "config.json"),
      JSON.stringify({
        baseUrl: "https://file.example.com",
        endpoint: "/v1",
        apiKey: "file-key",
        model: "file-model",
        contextWindowTokens: 100000,
        maxOutputTokens: 1000,
      }),
    );

    // 清掉环境(项目根 .env 会被 Bun 自动加载,里面有真实 BASE_URL 等,
    // 不清掉它们会按"env 优先"规则覆盖掉测试断言的值)
    const saved: Record<string, string | undefined> = {};
    for (const k of ["BASE_URL", "ENDPOINT", "API_KEY", "MODEL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.API_KEY = "env-key";
    process.env.MODEL = "env-model";
    process.env.CODERIG_HOME = tmp;

    const cfg = await loadConfig();

    expect(cfg?.apiKey).toBe("env-key"); // env 覆盖文件
    expect(cfg?.model).toBe("env-model");
    expect(cfg?.baseUrl).toBe("https://file.example.com"); // 没覆盖的用文件值

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.CODERIG_HOME;
    rmSync(tmp, { recursive: true });
  });

  test("loadConfig 缺关键字段返回 null", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "coderig-test-"));
    // 只写 baseUrl,缺 apiKey/model
    await Bun.write(join(tmp, "config.json"), JSON.stringify({ baseUrl: "https://x.com" }));

    // 同样要清环境:项目 .env 里有真实 API_KEY/MODEL,不清就读不出"不完整"
    const saved: Record<string, string | undefined> = {};
    for (const k of ["BASE_URL", "ENDPOINT", "API_KEY", "MODEL"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.CODERIG_HOME = tmp;

    const cfg = await loadConfig();
    expect(cfg).toBeNull();

    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.CODERIG_HOME;
    rmSync(tmp, { recursive: true });
  });

  test("saveConfig 写出的文件权限是 0600", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "coderig-test-"));
    process.env.CODERIG_HOME = tmp;

    await saveConfig({
      baseUrl: "https://x.com",
      endpoint: "/v1",
      apiKey: "secret-key",
      model: "test-model",
      contextWindowTokens: 100000,
      maxOutputTokens: 1000,
    });

    const stats = statSync(join(tmp, "config.json"));
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);

    delete process.env.CODERIG_HOME;
    rmSync(tmp, { recursive: true });
  });

  test("getConfig 未初始化时抛错,setConfig 后正常返回", () => {
    // 注意:模块级 current 是共享状态,本测试依赖它尚未被其它测试 setConfig。
    // config 测试独立文件跑,bun test 每文件一个模块实例,互不影响
    expect(() => getConfig()).toThrow("配置未初始化");
    setConfig({
      baseUrl: "https://x.com",
      endpoint: "/v1",
      apiKey: "k",
      model: "m",
      contextWindowTokens: 100000,
      maxOutputTokens: 1000,
    });
    expect(getConfig().model).toBe("m");
  });
});
