import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSettings, saveSettings, addPermission } from "./settings.ts";
import { settingsPath } from "./paths.ts";

let savedHome: string | undefined;
let tmp: string | undefined;

// CODERIG_HOME 重定向到临时目录(与 config 测试同款做法)
function setupTmp() {
  savedHome = process.env.CODERIG_HOME;
  tmp = mkdtempSync(join(tmpdir(), "coderig-test-"));
  process.env.CODERIG_HOME = tmp;
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODERIG_HOME;
  else process.env.CODERIG_HOME = savedHome;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("无 settings 文件时返回默认空权限", async () => {
  setupTmp();
  const s = await loadSettings();
  expect(s.permissions.allow).toEqual([]);
  expect(s.permissions.deny).toEqual([]);
});

test("save/load 往返", async () => {
  setupTmp();
  await saveSettings({
    permissions: { allow: ["write_file"], deny: ["bash"] },
  });
  const s = await loadSettings();
  expect(s.permissions.allow).toEqual(["write_file"]);
  expect(s.permissions.deny).toEqual(["bash"]);
});

test("addPermission 追加且幂等(重复不重复加)", async () => {
  setupTmp();
  await addPermission("allow", "write_file");
  await addPermission("allow", "write_file");
  await addPermission("deny", "bash");
  const s = await loadSettings();
  expect(s.permissions.allow).toEqual(["write_file"]);
  expect(s.permissions.deny).toEqual(["bash"]);
});

test("权限文件收紧 0600", async () => {
  setupTmp();
  await addPermission("allow", "edit_file");
  const mode = statSync(settingsPath()).mode & 0o777;
  expect(mode).toBe(0o600);
});
