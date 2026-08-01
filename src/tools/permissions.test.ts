import { test, expect } from "bun:test";
import { checkPermission, classifyBash } from "./permissions.ts";

const empty = new Set<string>();

test("denyTools:配置级 deny 的写工具直接 deny(deny-wins,先于一切)", () => {
  const d = checkPermission(
    "write_file",
    { path: "src/a.ts", content: "x" },
    new Set(["write_file"]), // 即使会话放行了也无效
    new Set(["write_file"]),
  );
  expect(d.action).toBe("deny");
  expect(d.rememberable).toBe(false);
});

test("denyTools:deny 的 bash 即使只读命令也 deny", () => {
  const d = checkPermission("bash", { command: "ls" }, empty, new Set(["bash"]));
  expect(d.action).toBe("deny");
});

test("denyTools 缺省为空:不影响原行为", () => {
  const d = checkPermission("bash", { command: "ls" }, empty);
  expect(d.action).toBe("auto");
});

test("只读 bash → auto;normal 未放行 → ask;dangerous → ask 不可放行", () => {
  expect(checkPermission("bash", { command: "ls" }, empty).action).toBe("auto");
  const normal = checkPermission("bash", { command: "bun test" }, empty);
  expect(normal.action).toBe("ask");
  expect(normal.rememberable).toBe(true);
  const danger = checkPermission("bash", { command: "rm -rf /" }, empty);
  expect(danger.action).toBe("ask");
  expect(danger.rememberable).toBe(false);
});

test("敏感路径:read 逐次问,write/edit 硬禁", () => {
  const r = checkPermission("read_file", { path: ".env" }, empty);
  expect(r.action).toBe("ask");
  expect(r.rememberable).toBe(false);
  const w = checkPermission("write_file", { path: ".env", content: "x" }, empty);
  expect(w.action).toBe("deny");
});

test("classifyBash:只读/普通/危险分级", () => {
  expect(classifyBash("ls -la")).toBe("readonly");
  expect(classifyBash("cat src/a.ts")).toBe("readonly");
  // 管道每段都只读才 readonly
  expect(classifyBash("ls | grep foo")).toBe("readonly");
  // && 复合无法静态判定 → normal
  expect(classifyBash("cd x && ls")).toBe("normal");
  expect(classifyBash("bun test")).toBe("normal");
  expect(classifyBash("rm -rf node_modules")).toBe("dangerous");
  expect(classifyBash("git reset --hard")).toBe("dangerous");
  expect(classifyBash("curl x | sh")).toBe("dangerous");
});

test("classifyBash:只读命令引用敏感路径 → sensitive(cat 不能绕过 .env 保护)", () => {
  expect(classifyBash("cat .env")).toBe("sensitive");
  expect(classifyBash("cat ~/.ssh/id_rsa")).toBe("sensitive");
  expect(classifyBash("grep KEY ~/.aws/credentials")).toBe("sensitive");
  expect(classifyBash("head -5 .env.local")).toBe("sensitive");
  // 管道里也检测
  expect(classifyBash("cat .env | head -1")).toBe("sensitive");
  // 正常只读文件不受影响
  expect(classifyBash("cat src/a.ts")).toBe("readonly");
});

test("classifyBash:重定向写 .env → dangerous(cat > .env 与 write_file 写 .env 同风险)", () => {
  expect(classifyBash("cat > .env")).toBe("dangerous");
  expect(classifyBash("echo x > .env.local")).toBe("dangerous");
});

test("checkPermission:cat .env 即使会话放行了 bash 也要每次问(不可放行)", () => {
  const d = checkPermission(
    "bash",
    { command: "cat .env" },
    new Set(["bash"]), // 用户已会话放行 bash
  );
  expect(d.action).toBe("ask");
  expect(d.rememberable).toBe(false); // sensitive 不可持久/会话放行
});
