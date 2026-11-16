import { describe, test, expect, beforeEach } from 'bun:test';
import { Kernel } from '../../src/kernel/kernel.ts';
import type { HostPort } from '../../src/host/port.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = join(import.meta.dir, '.tmp-ingest');

const GATES_YAML = `
schema_version: 1
runner: host
commands:
  test: { argv: ['bun', 'test'], arg_globs: ['src/**'] }
pipeline: []
global: []
probe_argv0: []
output_cap_kb: 256
`;
const TASK_YAML = `
schema_version: 1
id: T-IDEM-001
objective: 幂等验证
spec_refs: []
deps: []
role: dev
scope:
  write: ['src/**']
  shell: ['test']
blind_tests: false
acceptance_tests: []
checks: []
invariants: []
budget: { attempts: 3, tokens: 100000, minutes: 30, review_cycles: 1 }
`;

/** 最小 HostPort 桩（门禁效果层确定性：空管线 → gate-pass）。 */
function fakeHost(): HostPort {
  return {
    createSession: async () => ({ id: 'ses_fake' }),
    setPermissions: async () => {},
    setEnvironment: async () => {},
    putInstruction: async () => {},
    prompt: async (_id, _text, o) => ({ messageId: o.messageId }),
    awaitIdle: async () => 'timeout',
    interrupt: async () => {},
    sessionLog: function* () {} as unknown as HostPort['sessionLog'],
    sessionLogTail: async () => [],
    sessionMessages: async () => [],
    getSession: async () => ({ exists: true, active: false, directory: '', tokens: { input: 0, output: 0, reasoning: 0 }, costUsd: 0 }),
    createWorktree: async (_p, name) => ({ directory: join(BASE, name) }),
    listWorktrees: async () => [],
    removeWorktree: async () => {},
    exec: async () => ({ exit: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), timedOut: false, durationMs: 1 }),
    savedApprovals: async () => [],
    appVersion: () => 'contract-test',
  };
}

function freshDir(name: string): string {
  const dir = join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'gates.yaml'), GATES_YAML);
  writeFileSync(join(dir, 'tasks', 'T-IDEM-001.yaml'), TASK_YAML);
  return dir;
}

/** 建内核：leader + fake host 实例（门禁/HostPort 调用确定性）。 */
async function leaderKernel(dir: string): Promise<Kernel> {
  const k = new Kernel({ canonical: dir, projectID: 'p1' });
  k.attachInstance('test-instance', fakeHost, true);
  await k.init();
  return k;
}

function dispatchTo(k: Kernel, sessionId: string): void {
  const t = k.projection.task('T-IDEM-001');
  t.state = 'READY';
  const ev = k.appendTransition(t, 'dispatch', { sessionId, worktree: k.opts.canonical, forkSha: 'x', admissionId: 'm1', closureHash: 'c', attempt: 1, role: 'dev' });
  if (!ev) throw new Error('dispatch 事件追加失败');
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Kernel.ingest（R7 单写入口 + 幂等键 ${task}:${session}:${kind}:${seq}）', () => {
  beforeEach(() => rmSync(BASE, { recursive: true, force: true }));

  test('leader 直处理：首次接受 → 状态守卫挡住重提（fail-visible）→ 邮箱同键重放返回首次结果', async () => {
    const dir = freshDir('t1');
    const k = await leaderKernel(dir);
    dispatchTo(k, 'ses_a');
    const req = { kind: 'submit' as const, task: 'T-IDEM-001', session: 'ses_a', payload: { summary: 'v1' } };
    const r1 = await k.ingest(req);
    expect(r1.ok).toBe(true);
    expect(r1.queued).toBe('processed');
    expect(k.projection.task('T-IDEM-001').state).toBe('VERIFYING');
    // 直接再次 ingest：seq 已递增 → 新键 → 状态守卫拒绝（VERIFYING 无 dcae_submit 出边；fail-visible，非静默吞）
    const r2 = await k.ingest(req);
    expect(r2.ok).toBe(false);
    // 邮箱路径同键重放（信封重投）：键 ...:0 → duplicate
    const { enqueue } = await import('../../src/kernel/mailbox.ts');
    enqueue(k.dcaeDir, 'submit', 'T-IDEM-001:ses_a:submit:0', { task: 'T-IDEM-001', session: 'ses_a', summary: 'v1' });
    const r3 = await k.consumeMailbox();
    expect(r3).toBeUndefined(); // 消费无异常
    const events = k.eventLog.all().filter((e) => e.reason === 'dcae_submit');
    expect(events.length).toBe(1); // 未追加第二条提交事件
    // 门禁（空管线）→ gate-pass（异步效果层：轮询等待）
    await waitUntil(() => k.projection.task('T-IDEM-001').state === 'REVIEW');
    expect(k.projection.task('T-IDEM-001').state).toBe('REVIEW');
    await k.stop();
  });

  test('seq 递增：门禁失败回 RUNNING 后同一 attempt 的新提交正常接受（1.4 §5.3 seq 必要性）', async () => {
    const dir = freshDir('t2');
    const k = await leaderKernel(dir);
    dispatchTo(k, 'ses_c');
    const r1 = await k.ingest({ kind: 'submit', task: 'T-IDEM-001', session: 'ses_c', payload: { summary: 'v1' } });
    expect(r1.ok).toBe(true);
    // 模拟门禁失败回 RUNNING（gate-fail）
    const t = k.projection.task('T-IDEM-001');
    t.state = 'VERIFYING';
    k.appendTransition(t, 'gate-fail', { signature: 'sig-1' });
    expect(k.projection.task('T-IDEM-001').state).toBe('RUNNING');
    // 同一 attempt 下一次提交：seq=1 新键 → 接受（不含 seq 的键会误判重复——1.4 §5.3 逐字动机）
    const r2 = await k.ingest({ kind: 'submit', task: 'T-IDEM-001', session: 'ses_c', payload: { summary: 'v2' } });
    expect(r2.ok).toBe(true);
    expect(r2.queued).toBe('processed');
    const keys = k.eventLog.all().map((e) => (e.data as any)?.key).filter((x: unknown): x is string => typeof x === 'string');
    expect(keys).toContain('T-IDEM-001:ses_c:submit:0');
    expect(keys).toContain('T-IDEM-001:ses_c:submit:1');
    await k.stop();
  });

  test('follower 经邮箱投递 → 持有者消费 → 同一套幂等检查', async () => {
    const dir = freshDir('t3');
    const leader = await leaderKernel(dir);
    dispatchTo(leader, 'ses_b');
    const follower = new Kernel({ canonical: dir, projectID: 'p1' });
    await follower.init();
    expect(follower.isLeader()).toBe(false);
    const rf = await follower.ingest({ kind: 'submit', task: 'T-IDEM-001', session: 'ses_b', payload: { summary: 'from-follower' } });
    expect(rf.ok).toBe(true);
    expect(rf.queued).toBe('enqueued');
    await leader.consumeMailbox();
    const events = leader.eventLog.all().filter((e) => e.reason === 'dcae_submit' && e.task === 'T-IDEM-001');
    expect(events.length).toBe(1);
    expect((events[0]!.data as any).key).toBe('T-IDEM-001:ses_b:submit:0');
    expect(leader.projection.task('T-IDEM-001').state).toBe('VERIFYING');
    await leader.stop();
    await follower.stop();
  });

  test('question 工具语义：任意角色可触发 → BLOCKED + inbox 项创建', async () => {
    const dir = freshDir('t4');
    const k = await leaderKernel(dir);
    dispatchTo(k, 'ses_q');
    const r = await k.ingest({ kind: 'question', task: 'T-IDEM-001', session: 'ses_q', payload: { question: '上游规范如何处置？' } });
    expect(r.ok).toBe(true);
    expect(k.projection.task('T-IDEM-001').state).toBe('BLOCKED');
    expect(k.projection.task('T-IDEM-001').blockedReason).toBe('question');
    const { listInbox } = await import('../../src/inbox/inbox.ts');
    const items = listInbox(k);
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe('question');
    // 决策经 decision 邮箱（幂等键 = inbox 项 ID）
    const rd = await k.ingest({ kind: 'decision', task: 'T-IDEM-001', session: '*', payload: { inboxId: items[0]!.id, option: 'rework', kind: 'question' } });
    expect(rd.ok).toBe(true);
    // decision-applied → 恢复 READY
    expect(k.projection.task('T-IDEM-001').state).toBe('READY');
    // 重复决策：幂等
    const rd2 = await k.ingest({ kind: 'decision', task: 'T-IDEM-001', session: '*', payload: { inboxId: items[0]!.id, option: 'cancel', kind: 'question' } });
    expect(rd2.detail).toContain('重复');
    await k.stop();
  });
});
