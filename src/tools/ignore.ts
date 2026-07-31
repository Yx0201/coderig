// 忽略目录:node_modules 与各 VCS 目录。glob/grep/list_dir 三处共用,
// 避免各写一份导致过滤规则漂移(评审 P0-3 就是 grep 裸子串匹配误伤 .gitignore)。
//
// 只匹配"目录段"(路径中间 /xxx/ 或开头 xxx/ 或整条就是该目录),
// 不做裸子串匹配——否则 .gitignore / .github / CVS 这类"名字里带前缀"的文件会被误伤。
const IGNORED_DIRS = ["node_modules", ".git", ".svn", ".hg", "CVS"];

export function isIgnoredPath(f: string): boolean {
  return IGNORED_DIRS.some(
    (d) => f === d || f.startsWith(`${d}/`) || f.includes(`/${d}/`),
  );
}
