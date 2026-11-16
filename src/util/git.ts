/**
 * git CLI 辅助（argv 空间直接 spawn，不经 shell；内核是 refs/dcae/* 唯一写者，1.4 §6.7）。
 */
import { spawnSync } from 'node:child_process';
import { resolveArgv0 } from './argv-resolve.ts';

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], timeoutMs = 120_000): GitResult {
  const r = spawnSync(resolveArgv0('git'), args, {
    cwd,
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    encoding: 'buffer',
  });
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    stdout: r.stdout?.toString('utf8') ?? '',
    stderr: r.stderr?.toString('utf8') ?? '',
  };
}

export function revParse(cwd: string, ref: string): string | null {
  const r = git(cwd, ['rev-parse', '--verify', ref]);
  return r.ok ? r.stdout.trim() : null;
}

export function currentSha(cwd: string, ref = 'HEAD'): string | null {
  return revParse(cwd, ref);
}

export function updateRef(cwd: string, ref: string, sha: string): boolean {
  return git(cwd, ['update-ref', ref, sha]).ok;
}

export function headChangedFiles(cwd: string, base: string, head: string): string[] {
  const r = git(cwd, ['diff', '--name-only', `${base}..${head}`]);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** worktree 列表（含 canonical；判定目录归属）。 */
export function worktreeList(cwd: string): string[] {
  const r = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim().replace(/\\/g, '/'));
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree'], 10_000).ok;
}
