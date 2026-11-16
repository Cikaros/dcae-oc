import { describe, test, expect, beforeEach } from 'bun:test';
import { EventLog } from '../../src/kernel/events.ts';
import { Lease } from '../../src/kernel/lease.ts';
import { enqueue, consumeAll, doneKeys } from '../../src/kernel/mailbox.ts';
import { Projection } from '../../src/kernel/state.ts';
import { draftEvent } from '../../src/schema/event.ts';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(import.meta.dir, '.tmp-kernel');
function fresh(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'state'), { recursive: true });
  return TMP;
}

describe('EventLog append 三重守卫（1.4 §6.5）', () => {
  test('seq 连续 + epoch 匹配 + 即时重读 lock', () => {
    const dir = fresh();
    const lockFile = join(dir, 'lock.json');
    const writeLock = (epoch: number, holder: string, stale = false): void => {
      writeFileSync(lockFile, JSON.stringify({ schema_version: 1, epoch, holder: { kernelId: holder, pid: 1 }, heartbeat_at: stale ? new Date(Date.now() - 60_000).toISOString() : new Date().toISOString() }));
    };
    writeLock(7, 'k-A');
    const self = { epoch: 7, kernelId: 'k-A' };
    let guardFailures = 0;
    const log = new EventLog(join(dir, 'state', 'events.jsonl'), {
      readLock: () => {
        if (!existsSync(lockFile)) return null;
        const raw = JSON.parse(readFileSync(lockFile, 'utf8'));
        if (Date.now() - Date.parse(raw.heartbeat_at) > 20_000) return null;
        return { epoch: raw.epoch, holderKernelId: raw.holder.kernelId };
      },
      self,
      onGuardFailure: () => guardFailures++,
    });
    log.load();
    const e1 = log.append(draftEvent('T-1', 'RUNNING', 'VERIFYING', 'dcae_submit'));
    expect(e1.ok).toBe(true);
    expect(e1.ok && e1.event.seq).toBe(1);
    expect(e1.ok && e1.event.epoch).toBe(7);
    // (b) epoch 不符
    self.epoch = 6;
    const e2 = log.append(draftEvent('T-1', 'VERIFYING', 'VERIFYING', 'idle-nudge'));
    expect(e2.ok).toBe(false);
    expect(e2.ok === false && e2.reason).toBe('lease-lost');
    self.epoch = 7;
    // (c) 持有者换人（即时重读发现）
    writeLock(8, 'k-B');
    const e3 = log.append(draftEvent('T-1', 'VERIFYING', 'VERIFYING', 'idle-nudge'));
    expect(e3.ok).toBe(false);
    expect(guardFailures).toBeGreaterThan(0);
    // (a) 无 lock
    rmSync(lockFile);
    const e4 = log.append(draftEvent('T-1', 'VERIFYING', 'VERIFYING', 'idle-nudge'));
    expect(e4.ok === false && e4.reason).toBe('no-lease');
    // epoch 倒挂审计：手工注入一条更低 epoch 的事件（模拟脑裂残余）
    const { appendFileSync } = require('node:fs') as typeof import('node:fs');
    appendFileSync(log.file, JSON.stringify({ seq: 2, epoch: 6, ts: 'x', task: 'T-1', from: 'RUNNING', to: 'FAILED', reason: 'budget-time', actor: 'ghost' }) + '\n');
    log.load();
    const r = log.findEpochInversion();
    expect(r).not.toBeNull();
    expect(r?.at).toBe(2);
  });
});

describe('Lease（R4：心跳/陈旧/夺取）', () => {
  test('陈旧租约可接管，epoch 单调递增（max(lock,日志,snapshot)+1）', () => {
    const dir = fresh();
    const lease = new Lease(dir, 'k-new', () => {});
    expect(lease.tryAcquire(3)).toBe(true);
    expect(lease.epoch).toBe(4); // floor 3 → +1（无旧 lock）
    expect(lease.role).toBe('leader');
    // 新租约立即试图接管：失败（非陈旧且非自己）
    const other = new Lease(dir, 'k-other', () => {});
    expect(other.tryAcquire(0)).toBe(false);
    // 心跳陈旧后可接管，epoch = max(4, floor)+1（heartbeat_at 在内容里，直接改）
    const lock = JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8'));
    lock.heartbeat_at = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
    expect(other.tryAcquire(2)).toBe(true);
    expect(other.epoch).toBe(5);
    expect(other.verify()).toBe(true);
    expect(lease.verify()).toBe(false); // 旧持有者写前验证失败
  });
});

describe('Mailbox（R8：temp+rename 原子落盘、rename 认领、幂等键重建）', () => {
  beforeEach(() => fresh());
  test('enqueue → consumeAll 认领 → done 目录 + 幂等键', () => {
    const dir = fresh();
    enqueue(dir, 'submit', 'T-1:s1:submit:0', { summary: 'x' });
    enqueue(dir, 'decision', 'INBOX-000001', { option: 'y' });
    expect(doneKeys(dir).size).toBe(0);
    const claimed = consumeAll(dir);
    expect(claimed.length).toBe(2);
    expect(claimed[0]!.env.kind).toBe('submit');
    expect(doneKeys(dir).size).toBe(2);
    // 二次消费为空（已认领）
    expect(consumeAll(dir).length).toBe(0);
  });
  test('信封文件原子存在（无 tmp 残留）', () => {
    const dir = fresh();
    enqueue(dir, 'question', 'T-1:s1:question:0', { question: '?' });
    const files = readdirSafe(join(dir, 'queue', 'question'));
    expect(files.filter((f) => f.endsWith('.json')).length).toBe(1);
    expect(files.filter((f) => f.includes('.tmp')).length).toBe(0);
  });
});

describe('投影重建（重启安全：事件重放 + 快照）', () => {
  test('dispatch → submit → gate-pass → review-pass 状态链', () => {
    const p = new Projection();
    const mk = (seq: number, task: string, from: any, to: any, reason: any, data?: unknown) => ({
      seq, epoch: 1, ts: '2026-11-16T00:00:00Z', task, from, to, reason, actor: 'kernel', ...(data !== undefined ? { data } : {}),
    });
    p.apply(mk(1, 'T-1', 'PENDING', 'TEST_WRITING', 'deps-merged', { blind: true }));
    expect(p.task('T-1').state).toBe('TEST_WRITING');
    p.apply(mk(2, 'T-1', 'TEST_WRITING', 'READY', 'test-submit', { key: 'T-1:s:submit:0' }));
    expect(p.task('T-1').state).toBe('READY');
    p.apply(mk(3, 'T-1', 'READY', 'RUNNING', 'dispatch', { sessionId: 's1', worktree: 'w', admissionId: 'm1', attempt: 1 }));
    expect(p.task('T-1').sessionId).toBe('s1');
    p.apply(mk(4, 'T-1', 'RUNNING', 'VERIFYING', 'dcae_submit', { key: 'T-1:s1:submit:0' }));
    p.apply(mk(5, 'T-1', 'VERIFYING', 'REVIEW', 'gate-pass'));
    p.apply(mk(6, 'T-1', 'REVIEW', 'ACCEPTED', 'review-pass', { frozenRefSha: 'sha1' }));
    expect(p.task('T-1').state).toBe('ACCEPTED');
    expect(p.task('T-1').frozenSha).toBe('sha1');
    expect(p.seenKeys.has('T-1:s1:submit:0')).toBe(true);
    // 失败类迁移消耗 attempt
    p.apply(mk(7, 'T-2', 'RUNNING', 'FAILED', 'budget-time'));
    expect(p.task('T-2').attempt).toBe(2);
    // 快照往返
    const snap = p.toSnapshot(1);
    const p2 = new Projection();
    expect(p2.loadSnapshot(snap)).toBe(true);
    expect(p2.task('T-1').state).toBe('ACCEPTED');
    expect(p2.seenKeys.has('T-1:s1:submit:0')).toBe(true);
  });
  test('孤儿表状态：idle-nudge 计数', () => {
    const p = new Projection();
    p.apply({ seq: 1, epoch: 1, ts: '', task: 'T-1', from: 'RUNNING', to: 'RUNNING', reason: 'idle-nudge', actor: 'kernel' });
    p.apply({ seq: 2, epoch: 1, ts: '', task: 'T-1', from: 'RUNNING', to: 'RUNNING', reason: 'idle-nudge', actor: 'kernel' });
    expect(p.task('T-1').idleNudges).toBe(2);
  });
});

function readdirSafe(d: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(d);
}
