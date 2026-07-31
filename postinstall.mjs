#!/usr/bin/env node

// ===== postinstall:从平台包装真二进制 =====
//
// 照 opencode 的路线:壳包只有 bin/ 占位 + postinstall 脚本 + optionalDependencies。
// npm 装壳包时,os/cpu 字段让它只装匹配当前平台的那一个平台包,
// postinstall 从平台包里把真二进制 link 到 bin/coderig。

import childProcess from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
);

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const archMap = { x64: "x64", arm64: "arm64" };

const platform = platformMap[os.platform()] ?? os.platform();
const arch = archMap[os.arch()] ?? os.arch();
const base = `coderig-${platform}-${arch}`;
const sourceBinary = platform === "windows" ? "coderig.exe" : "coderig";
const targetBinary = path.join(__dirname, "bin", "coderig");

function isMusl() {
  if (platform !== "linux") return false;
  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {
    // Ignore
  }
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], {
      encoding: "utf8",
    });
    return `${result.stdout || ""}${result.stderr || ""}`
      .toLowerCase()
      .includes("musl");
  } catch {
    return false;
  }
}

function packageNames() {
  if (platform === "linux" && isMusl() && arch === "x64") {
    return [`${base}-musl`, base];
  }
  return [base];
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const binaryPath = path.join(
    path.dirname(packageJsonPath),
    "bin",
    sourceBinary,
  );
  if (!fs.existsSync(binaryPath))
    throw new Error(`Binary not found at ${binaryPath}`);
  return binaryPath;
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
  fs.chmodSync(target, 0o755);
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function main() {
  for (const name of packageNames()) {
    try {
      copyBinary(resolveBinary(name), targetBinary);
      if (verifyBinary()) return;
    } catch {
      // Try next
    }
  }
  throw new Error(
    `找不到匹配的平台包。请手动安装: ${packageNames().join(" or ")}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
