#!/usr/bin/env bun

// ===== 编译与打包 =====
//
// 照 opencode 的路线:bun build --compile 出单文件二进制(内置 Bun runtime),
// 按平台分包发 npm。用户无需装任何运行时。
//
// 关键:autoloadDotenv: false——实测不关会吞掉用户项目的 .env,
// 污染 API_KEY/MODEL。opencode 同样设了 false。

const TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "windows", arch: "x64" },
];

for (const { os, arch, abi } of TARGETS) {
  const target = abi ? `bun-${os}-${arch}-${abi}` : `bun-${os}-${arch}`;
  const name = `coderig-${os}-${arch}${abi ? `-${abi}` : ""}`;
  const outfile = `dist/${name}/bin/coderig${os === "windows" ? ".exe" : ""}`;

  console.log(`building ${name}...`);
  const result = await Bun.build({
    entrypoints: ["./index.ts"],
    compile: {
      autoloadDotenv: false, // 必须:实测不关会吞掉用户项目的 .env
      autoloadBunfig: false,
      target: target as any,
      outfile,
    },
  });
  if (!result.success) {
    console.error(`✗ ${name} 编译失败`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

console.log("\n所有平台编译完成,dist/ 下可直接发包");
