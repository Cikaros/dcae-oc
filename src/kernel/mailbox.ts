/**
 * Mailbox —— 跨进程请求邮箱（R7/R8；1.4 §5.3/§6.5）。
 * .dcae/queue/<kind>/<ulid>.json：任何进程可写（temp+rename 原子落盘）；
 * 仅租约持有者消费：rename 到 done/ 原子认领（ENOENT/EEXIST → 他人已认领 → 跳过）。
 * 邮箱不是权威状态，事件日志才是。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write.ts';
import { ulid } from '../util/ulid.ts';

export const MAILBOX_KINDS = ['submit', 'test_submit', 'question', 'dcp', 'decision'] as const;
export type MailboxKind = (typeof MAILBOX_KINDS)[number];

export interface Envelope<P = unknown> {
  schema_version: 1;
  ulid: string;
  kind: MailboxKind;
  idempotencyKey: string;
  payload: P;
  enqueuedAt: string;
}

export function queueDir(dcaeDir: string): string {
  return join(dcaeDir, 'queue');
}

export function enqueue<P>(dcaeDir: string, kind: MailboxKind, idempotencyKey: string, payload: P): Envelope<P> {
  const env: Envelope<P> = {
    schema_version: 1,
    ulid: ulid(),
    kind,
    idempotencyKey,
    payload,
    enqueuedAt: new Date().toISOString(),
  };
  const dir = join(queueDir(dcaeDir), kind);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'done'), { recursive: true });
  atomicWrite(join(dir, `${env.ulid}.json`), JSON.stringify(env));
  return env;
}

export interface Claimed<P> {
  env: Envelope<P>;
  file: string;
  doneFile: string;
}

/** 消费一轮：按序认领全部待处理信封。 */
export function consumeAll<P>(dcaeDir: string): Claimed<P>[] {
  const root = queueDir(dcaeDir);
  const out: Claimed<P>[] = [];
  for (const kind of MAILBOX_KINDS) {
    const dir = join(root, kind);
    if (!existsSync(dir)) continue;
    const doneDir = join(dir, 'done');
    mkdirSync(doneDir, { recursive: true });
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, f);
      const doneFile = join(doneDir, f);
      try {
        renameSync(file, doneFile); // 原子认领
      } catch {
        continue; // ENOENT/EEXIST/EPERM：他人已认领
      }
      try {
        const env = JSON.parse(readFileSync(doneFile, 'utf8')) as Envelope<P>;
        out.push({ env, file, doneFile });
      } catch {
        try { rmSync(doneFile, { force: true }); } catch { /* 尽力 */ }
      }
    }
  }
  return out;
}

/** done/ 中的幂等键重建源（重启安全）。 */
export function doneKeys(dcaeDir: string): Set<string> {
  const root = queueDir(dcaeDir);
  const out = new Set<string>();
  for (const kind of MAILBOX_KINDS) {
    const doneDir = join(root, kind, 'done');
    if (!existsSync(doneDir)) continue;
    try {
      for (const f of readdirSync(doneDir).filter((x) => x.endsWith('.json'))) {
        try {
          const env = JSON.parse(readFileSync(join(doneDir, f), 'utf8')) as Envelope;
          out.add(env.idempotencyKey);
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 目录不可读 */ }
  }
  return out;
}
