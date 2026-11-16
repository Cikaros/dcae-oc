/**
 * argv[0] 解析 —— 架构设计 §3.19 / 项目设计 §4.1。
 * Windows：`spawn` 在 shell:false 下对裸命令名 + .cmd/.bat shim 直接 EINVAL；
 * 必须先解析出可执行文件绝对路径（经 PATH × PATHEXT 探测）再 spawn。
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WIN_EXTS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.toLowerCase());

export function resolveArgv0(cmd0: string): string {
  // 已含路径分隔符或盘符：按直接路径解析（补 Windows 扩展名探测）
  if (cmd0.includes('/') || cmd0.includes('\\') || /^[A-Za-z]:/.test(cmd0)) {
    return probe(cmd0) ?? cmd0;
  }
  // PATH 扫描
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter())) {
    if (!dir) continue;
    const hit = probe(join(dir, cmd0));
    if (hit) return hit;
  }
  return cmd0; // 解析失败：原样交回，spawn 报 ENOENT（fail-visible）
}

function delimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function probe(candidate: string): string | null {
  const norm = candidate.replace(/\\/g, '/');
  if (isExecutableFile(norm)) return norm;
  if (process.platform === 'win32' && !/\.[a-z]+$/i.test(norm)) {
    for (const ext of WIN_EXTS) {
      const withExt = norm + ext;
      if (isExecutableFile(withExt)) return withExt;
    }
  }
  return null;
}

function isExecutableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
