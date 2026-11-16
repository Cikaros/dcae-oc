/**
 * DCAE glob 语义（1.4 §6.2 全局统一）：
 * - `*` 不跨 `/`；`**` 跨；`?` 匹配单字符；`X/**` 匹配 X 自身与其下所有路径。
 * 与平台通配符（`* → .*` 跨 `/`）语义不同，二者不得混用（架构设计 §8.2 翻译表）。
 * 输入/输出路径一律 POSIX 归一化（util/paths）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeForMatch } from './paths.ts';

/** DCAE glob → RegExp（对归一化 POSIX 路径整体锚定）。 */
export function dcaeGlobToRegExp(pattern: string): RegExp {
  const p = normalizeForMatch(pattern);
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**`：跨段。特殊形态 `X/**`（含 X 自身）与裸 `/**`。
        if (re.endsWith('/') && i + 2 === p.length) {
          // 形如 `X/**`：X 自身 + 其下全部
          re = re.slice(0, -1); // 去掉尾部 '/'
          re += '(/.*)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

export function dcaeGlobMatch(pattern: string, path: string): boolean {
  return dcaeGlobToRegExp(pattern).test(normalizeForMatch(path));
}

/** 任一模式命中。 */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  const n = normalizeForMatch(path);
  return patterns.some((pat) => dcaeGlobMatch(pat, n));
}

/**
 * 在 cwd 下展开 glob 模式为存在的具体路径（GateRunner 用，1.4 §6.3 "glob 由内核展开"）。
 * 非通配模式：存在即返回其自身，不存在返回空（展开为空即校验失败，不执行）。
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  const p = normalizeForMatch(pattern);
  const base = normalizeForMatch(cwd).replace(/\/$/, '');
  if (!p.includes('*') && !p.includes('?')) {
    const abs = join(base, p);
    return existsSync(abs) ? [p] : [];
  }
  const segs = p.split('/');
  const results: string[] = [];
  walk(base, segs, 0, '', results);
  return results.sort();

  function walk(dirAbs: string, segs: string[], si: number, rel: string, out: string[]): void {
    if (si >= segs.length) {
      out.push(rel);
      return;
    }
    const seg = segs[si]!;
    if (seg === '**') {
      // `**`：当前层与所有递归层。`X/**` 语义（含 X 自身）由上层的剩余段处理：
      // 此处把「本目录自身」与「递归所有子目录」都作为可继续匹配的候选。
      collectRecursive(dirAbs, rel, out);
      // 直接以 `**` 结尾：X 自身与其下全部都已收集，返回
      if (si === segs.length - 1) return;
      // 否则（如 `**/foo`）：对每个候选目录继续匹配剩余段
      for (const dir of collectDirsRecursive(dirAbs)) {
        walk(join(dirAbs, dir), segs, si + 1, rel ? `${rel}/${dir}` : dir, out);
      }
      return;
    }
    if (!seg.includes('*') && !seg.includes('?')) {
      const abs = join(dirAbs, seg);
      if (!existsSync(abs)) return;
      const nextRel = rel ? `${rel}/${seg}` : seg;
      if (si === segs.length - 1) {
        out.push(nextRel);
      } else {
        walk(abs, segs, si + 1, nextRel, out);
      }
      return;
    }
    // 通配段：扫描目录
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    const segRe = segmentRegExp(seg);
    for (const e of entries) {
      if (!segRe.test(e)) continue;
      const abs = join(dirAbs, e);
      const nextRel = rel ? `${rel}/${e}` : e;
      if (si === segs.length - 1) {
        out.push(nextRel);
      } else if (statSync(abs).isDirectory()) {
        walk(abs, segs, si + 1, nextRel, out);
      }
    }
  }

  function collectRecursive(dirAbs: string, rel: string, out: string[]): void {
    // rel 自身 + 递归全部条目
    if (rel !== '') out.push(rel);
    for (const dir of collectAllRecursive(dirAbs)) {
      out.push(rel ? `${rel}/${dir}` : dir);
    }
  }

  function collectAllRecursive(dirAbs: string): string[] {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return out;
    }
    for (const e of entries) {
      const abs = join(dirAbs, e);
      out.push(e);
      if (statSync(abs).isDirectory()) {
        for (const sub of collectAllRecursive(abs)) out.push(`${e}/${sub}`);
      }
    }
    return out;
  }

  function collectDirsRecursive(dirAbs: string): string[] {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return out;
    }
    for (const e of entries) {
      const abs = join(dirAbs, e);
      if (statSync(abs).isDirectory()) {
        out.push(e);
        for (const sub of collectDirsRecursive(abs)) out.push(`${e}/${sub}`);
      }
    }
    return out;
  }
}

/** 单段通配 → RegExp（不跨 `/`；用于目录扫描时的文件名匹配）。 */
function segmentRegExp(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
