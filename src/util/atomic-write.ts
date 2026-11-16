/**
 * 原子文件写（temp + rename）—— 架构设计 §3.19 / 1.4 §6.5。
 * Windows 上 rename 覆盖可能因杀毒/索引器短暂 EPERM/EBUSY，做有界重试。
 */
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ulid } from './ulid.ts';

const RETRIES = 10;
const RETRY_DELAY_MS = 25;

function sleep(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** 原子写文件：先写同卷临时文件，再 rename 到目标。目标父目录自动创建。 */
export function atomicWrite(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${ulid()}.tmp`);
  writeFileSync(tmp, data);
  try {
    renameWithRetry(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw e;
  }
}

function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown;
  for (let i = 0; i < RETRIES; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw e; // 源没了：致命
      lastErr = e; // EPERM/EBUSY/EACCES：Windows 短暂锁，重试
      sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}
