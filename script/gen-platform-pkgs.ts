#!/usr/bin/env bun

// ===== 生成平台包的 package.json =====
//
// 每个平台包只需要:package.json(name/version/os/cpu)+ bin/coderig(真二进制)。
// 壳包的 optionalDependencies 指向这些包,npm 按 os/cpu 只装匹配的那个。

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const TARGETS = [
  { os: "darwin", arch: "arm64", name: "coderig-darwin-arm64" },
  { os: "darwin", arch: "x64", name: "coderig-darwin-x64" },
  { os: "linux", arch: "x64", name: "coderig-linux-x64" },
  { os: "linux", arch: "arm64", name: "coderig-linux-arm64" },
  { os: "linux", arch: "x64", abi: "musl", name: "coderig-linux-x64-musl" },
  { os: "windows", arch: "x64", name: "coderig-windows-x64" },
];

const VERSION = "0.3.0";

for (const { os, arch, abi, name } of TARGETS) {
  const dir = join("dist", name);
  mkdirSync(join(dir, "bin"), { recursive: true });

  const pkg: any = {
    name,
    version: VERSION,
    description: `coderig platform binary for ${os}-${arch}${abi ? `-${abi}` : ""}`,
    license: "MIT",
    // files 白名单:平台包只发 bin/ + package.json,不靠 .npmignore 兜底
    files: ["bin"],
    os: [os === "windows" ? "win32" : os],
    cpu: [arch],
  };
  if (abi) pkg.libc = [abi];

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  console.log(`✓ ${name}/package.json`);
}

console.log("\n平台包 package.json 生成完成");
