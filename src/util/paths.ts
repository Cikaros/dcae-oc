/**
 * 路径归一化 —— 全代码库唯一的路径出入口（架构设计 §3.19）。
 *
 * 纪律（项目设计 §4.1）：
 * - 内部一律 POSIX 形态（正斜杠）存储与匹配；
 * - 平台权限匹配对整个归一化路径首尾锚定、Windows 大小写不敏感（1.4 §6.2 [D]）；
 * - 只在系统调用边界转换回原生形态（本仓的系统调用一律走 node:fs，接受正斜杠，故
 *   通常无需反向转换；此模块仍提供 toNative 以备 spawn cwd 等场景）。
 */

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 归一化用于匹配的路径：POSIX 化 + 折叠重复斜杠 + 去尾部斜杠（保留根 "/"）。 */
export function normalizeForMatch(p: string): string {
  let s = toPosix(p);
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Windows 大小写不敏感的比较键；非 Windows 卷保留原大小写。 */
export function matchKey(p: string): string {
  const n = normalizeForMatch(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function joinPosix(...parts: string[]): string {
  const joined = parts
    .filter((x) => x !== '' && x !== undefined)
    .map((x) => toPosix(x))
    .join('/')
    .replace(/\/{2,}/g, '/');
  return normalizeForMatch(joined);
}

/** 绝对化：以 base（绝对目录）解析相对路径。 */
export function absolutize(p: string, base: string): string {
  const n = normalizeForMatch(p);
  if (n.startsWith('/')) return n;
  if (/^[A-Za-z]:\//.test(n)) return n;
  return joinPosix(normalizeForMatch(base), n);
}

export function toNative(p: string): string {
  return process.platform === 'win32' ? normalizeForMatch(p).replace(/\//g, '\\') : normalizeForMatch(p);
}

/** 提取路径中 `..` 段的存在（读审计/遍历兜底的判定辅助）。 */
export function hasParentTraversal(p: string): boolean {
  const segs = toPosix(p).split('/');
  return segs.includes('..');
}
