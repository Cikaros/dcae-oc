/**
 * Scheduler —— 挑选 READY 与 TEST_WRITING 任务，施加并发与预算限制并 dispatch（1.4 §5.1）。
 * 只在内核持有租约时运行（R4）；ready 之前不 dispatch（R9）。
 * 等待器不是内存状态而是可重建的推导：心跳对每个 RUNNING 任务检查 waiter 存在性（1.4 §7.2）。
 */
import type { Kernel } from './kernel.ts';
import { loadAllTaskDefs } from '../tasks/load.ts';
import { join } from 'node:path';

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Map<string, AbortController>();
  private reviewWaiters = new Map<string, AbortController>();
  private budgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private ticking = false;
  private merging = false;

  constructor(private kernel: Kernel) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const [, c] of this.waiters) c.abort();
    this.waiters.clear();
    for (const [, c] of this.reviewWaiters) c.abort();
    this.reviewWaiters.clear();
    for (const [, t] of this.budgetTimers) clearTimeout(t);
    this.budgetTimers.clear();
  }

  /** 心跳 + 唤醒入口（幂等；并发防重入）。 */
  async tick(): Promise<void> {
    if (this.ticking || !this.kernel.ready) return;
    this.ticking = true;
    try {
      // follower 接管循环（1.4 §6.5：lock 陈旧 → 任何内核可接管——leader 死亡后的领导权转移）
      if (!this.kernel.isLeader()) {
        const floor = this.kernel.eventLog.lastEpoch();
        if (this.kernel.lease.tryAcquire(floor)) {
          this.kernel.log.info('scheduler', '接管领导权（lock 陈旧）', { epoch: this.kernel.lease.epoch });
        }
        return; // follower：不调度（R4）
      }
      await this.reconcileWaiters();
      await this.tryDispatch();
      await this.runReviewFlow();
      await this.runMergeTrain();
      await this.kernel.consumeMailbox(); // 兜底消费（不依赖 onLeadershipGained 的 timer 存活）
    } finally {
      this.ticking = false;
    }
  }

  /** 孤儿等待重建（1.4 §7.2 孤儿 RUNNING 表）。 */
  private async reconcileWaiters(): Promise<void> {
    for (const t of this.kernel.projection.tasks.values()) {
      if (t.state !== 'RUNNING' && t.state !== 'TEST_WRITING') continue;
      if (!t.sessionId) continue;
      if (this.waiters.has(t.id)) continue;
      // 等待器缺失（reload/卸载/重启后）→ 重建
      const kind = t.state === 'TEST_WRITING' ? 'tester' : 'dev';
      this.attachWaiter(t.id, t.sessionId, kind);
    }
    // 清理已不在 RUNNING/TEST_WRITING 的等待器
    for (const [taskId, c] of [...this.waiters]) {
      const t = this.kernel.projection.tasks.get(taskId);
      if (!t || (t.state !== 'RUNNING' && t.state !== 'TEST_WRITING')) {
        c.abort();
        this.waiters.delete(taskId);
      }
    }
  }

  /** dispatch 挑选（原则 10：并发默认 1；并行只在基准显示收益处放宽）。 */
  private async tryDispatch(): Promise<void> {
    const defs = loadAllTaskDefs(join(this.kernel.opts.canonical, 'tasks'));
    const byId = new Map(defs.map((d) => [d.id, d]));
    const running = [...this.kernel.projection.tasks.values()].filter((t) => t.state === 'RUNNING').length;
    const testing = [...this.kernel.projection.tasks.values()].filter((t) => t.state === 'TEST_WRITING').length;

    // READY → RUNNING（dev）
    if (running < this.kernel.config.concurrency) {
      const ready = [...this.kernel.projection.tasks.values()]
        .filter((t) => t.state === 'READY')
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const t of ready) {
        const def = byId.get(t.id);
        if (!def) continue;
        if (!depsMerged(this.kernel, def)) continue;
        if (this.kernel.projection.tasks.get(t.id)?.state !== 'READY') continue;
        const { dispatchTask } = await import('../dispatch/dispatcher.ts');
        const out = await dispatchTask(this.kernel, def);
        if (!out.ok) {
          this.kernel.log.warn('scheduler', 'dispatch 失败', { task: t.id, detail: out.detail });
          continue;
        }
        this.attachWaiter(t.id, out.sessionId!, 'dev');
        this.attachBudgetTimer(t.id, def.budget.minutes * 60_000);
        break; // 一次心跳 dispatch 一个（并发 1）
      }
    }

    // PENDING →（依赖全部 MERGED）TEST_WRITING / READY
    for (const def of defs) {
      const t = this.kernel.projection.tasks.get(def.id);
      if (!t || t.state !== 'PENDING') continue;
      if (!depsMerged(this.kernel, def)) continue;
      if (def.blind_tests) {
        if (testing >= this.kernel.config.testerConcurrency) continue;
        if (this.kernel.projection.tasks.get(def.id)?.state !== 'PENDING') continue;
        const out = await this.startTester(def);
        if (out.ok) {
          this.attachWaiter(def.id, out.sessionId!, 'tester');
          this.attachBudgetTimer(def.id, (def.blind_test?.minutes ?? 15) * 60_000, true);
          break;
        }
      } else {
        const ev = this.kernel.appendTransition(t, 'deps-merged', { blind: false });
        if (ev) this.kernel.log.info('scheduler', '任务就绪', { task: def.id });
      }
    }
  }

  private async startTester(def: import('../schema/task.ts').TaskDef): Promise<{ ok: boolean; sessionId?: string }> {
    const t = this.kernel.projection.task(def.id);
    const ev = this.kernel.appendTransition(t, 'deps-merged', { blind: true });
    if (!ev) return { ok: false };
    const { dispatchTester } = await import('../dispatch/dispatcher.ts');
    const out = await dispatchTester(this.kernel, def);
    if (!out.ok) {
      this.kernel.log.warn('scheduler', 'tester dispatch 失败', { task: def.id, detail: out.detail });
    }
    return out;
  }

  /** awaitIdle 等待器（wait 无参数；完成信号 = 显式 submit；事件/等待只降低延迟）。 */
  attachWaiter(taskId: string, sessionId: string, kind: 'dev' | 'tester'): void {
    if (this.waiters.has(taskId)) return;
    const controller = new AbortController();
    this.waiters.set(taskId, controller);
    void this.waitLoop(taskId, sessionId, kind, controller.signal);
  }

  private async waitLoop(taskId: string, sessionId: string, kind: 'dev' | 'tester', signal: AbortSignal): Promise<void> {
    const kernel = this.kernel;
    let timeoutMs = kind === 'tester' ? 15 * 60_000 : 30 * 60_000;
    while (!signal.aborted && kernel.ready && kernel.isLeader()) {
      const t = kernel.projection.tasks.get(taskId);
      if (!t || (t.state !== 'RUNNING' && t.state !== 'TEST_WRITING')) return;
      try {
        const outcome = await kernel.hostForSession(sessionId).awaitIdle(sessionId, { timeoutMs, signal });
        if (signal.aborted) return;
        const cur = kernel.projection.tasks.get(taskId);
        if (!cur || (cur.state !== 'RUNNING' && cur.state !== 'TEST_WRITING')) return;
        if (outcome === 'idle') {
          // 无提交空闲两步（1.4 §7.2）：第一次提醒（不耗 attempt），第二次 FAILED
          const nudges = cur.idleNudges;
          if (nudges === 0) {
            kernel.appendMarkForTask(cur, 'idle-nudge', { sessionId, kind });
            await this.injectReminder(sessionId, taskId, kind);
            await new Promise((r) => setTimeout(r, 60_000)); // 提醒后观察窗：给 LLM 回合时间（节流）
          } else {
            await collectProvisionalEvidence(kernel, taskId, sessionId);
            kernel.appendTransition(cur, 'idle-no-submit', { sessionId, kind });
            return;
          }
        } else if (outcome === 'failed' || outcome === 'interrupted') {
          // 异常终结：不等同空闲——直接 attempt 失败路径（不注入提醒）
          await collectProvisionalEvidence(kernel, taskId, sessionId);
          kernel.appendTransition(cur, outcome === 'failed' ? 'execution-failed' : 'execution-interrupted', { sessionId });
          return;
        } else {
          // timeout：getSession 三分支（active 重等/非 active 查日志/仍无→保守无提交空闲）
          const s = await kernel.hostForSession(sessionId).getSession(sessionId);
          if (s.active) {
            kernel.appendMarkForTask(cur, 'wait-continued', { sessionId });
            timeoutMs = 5 * 60_000; // 重等短周期（受预算定时器总约束）
            continue;
          }
          const marker = await latestMarker(kernel, sessionId);
          if (marker === 'succeeded') {
            kernel.appendMarkForTask(cur, 'idle-nudge', { sessionId, kind, via: 'log-replay' });
            await this.injectReminder(sessionId, taskId, kind);
            await new Promise((r) => setTimeout(r, 60_000));
          } else if (marker === 'failed' || marker === 'interrupted') {
            kernel.appendTransition(cur, marker === 'failed' ? 'execution-failed' : 'execution-interrupted', { sessionId, via: 'log-replay' });
            return;
          } else {
            kernel.appendMarkForTask(cur, 'idle-nudge', { sessionId, kind, via: 'conservative' });
            await this.injectReminder(sessionId, taskId, kind);
            await new Promise((r) => setTimeout(r, 60_000)); // 节流：避免失败路径风暴（实测教训）
          }
        }
        timeoutMs = 5 * 60_000;
      } catch (e) {
        if (signal.aborted) return;
        kernel.log.warn('scheduler', '等待循环异常，退避重试', { taskId, error: String(e) });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  private async injectReminder(sessionId: string, taskId: string, kind: 'dev' | 'tester'): Promise<void> {
    const text = kind === 'tester'
      ? '已完成请 dcae_test_submit 提交；受阻请 dcae_question；未完成请继续。'
      : '已完成请 dcae_submit；受阻请 dcae_question；未完成请继续。';
    try {
      // fire-and-forget（prompt 挂起不得堵死等待循环——30s 护栏在 HostPort.prompt 内）
      void this.kernel.hostForSession(sessionId).prompt(sessionId, text, { messageId: `msg_${Date.now().toString(36)}${taskId}`, delivery: 'queue' }).catch((e) => {
        this.kernel.log.warn('scheduler', '提醒注入失败', { taskId, error: String(e) });
      });
    } catch (e) {
      this.kernel.log.warn('scheduler', '提醒注入失败（等待器将在下轮重试）', { taskId, error: String(e) });
    }
  }

  /** 预算硬执行：wall-clock 到期 → interrupt + provisional 证据 + FAILED（1.4 §7.2）。 */
  attachBudgetTimer(taskId: string, ms: number, tester = false): void {
    const prev = this.budgetTimers.get(taskId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      void (async () => {
        const kernel = this.kernel;
        const t = kernel.projection.tasks.get(taskId);
        if (!t || !t.sessionId) return;
        if (t.state !== 'RUNNING' && t.state !== 'TEST_WRITING') return;
        try { await kernel.hostForSession(t.sessionId).interrupt(t.sessionId); } catch { /* 已停 */ }
        await collectProvisionalEvidence(kernel, taskId, t.sessionId);
        if (t.state === 'TEST_WRITING') {
          // TEST_WRITING 预算耗尽 → BLOCKED + inbox（1.4 §6.6）
          const { createInboxItem } = await import('../inbox/inbox.ts');
          createInboxItem(kernel, {
            kind: 'test-exhausted',
            task: taskId,
            question: `tester 预算耗尽（${taskId}）：再试一次 / 人工编写测试 / 取消任务？`,
            options: [
              { id: 'retry', label: '再试一次' },
              { id: 'manual', label: '人工编写测试' },
              { id: 'cancel', label: '取消任务' },
            ],
          });
          kernel.appendTransition(t, 'test-exhausted', { reason: 'budget-time' });
        } else {
          kernel.appendTransition(t, 'budget-time', { sessionId: t.sessionId });
        }
        const c = this.waiters.get(taskId);
        c?.abort();
        this.waiters.delete(taskId);
      })();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.budgetTimers.set(taskId, timer);
  }

  // ---------- 审查闭环（REVIEW 态：dispatch reviewer → verdict → 迁移）与合并列车触发 ----------

  /** REVIEW 态：为无 reviewer 会话的任务 dispatch；已有的挂等待器。 */
  async runReviewFlow(): Promise<void> {
    for (const t of this.kernel.projection.tasks.values()) {
      if (t.state !== 'REVIEW') continue;
      if (t.reviewSessionId) {
        if (!this.reviewWaiters.has(t.id)) this.attachReviewWaiter(t.id, t.reviewSessionId);
        continue;
      }
      const def = this.kernel.taskDef(t.id);
      if (!def) continue;
      const { dispatchReviewer } = await import('../dispatch/dispatcher.ts');
      const out = await dispatchReviewer(this.kernel, def);
      if (!out.ok || !out.sessionId) {
        this.kernel.log.warn('scheduler', 'reviewer dispatch 失败', { task: t.id, detail: out.detail });
        continue;
      }
      t.reviewSessionId = out.sessionId;
      this.kernel.log.info('scheduler', 'reviewer 已调度', { task: t.id, sessionId: out.sessionId });
      this.attachReviewWaiter(t.id, out.sessionId);
    }
  }

  attachReviewWaiter(taskId: string, sessionId: string): void {
    if (this.reviewWaiters.has(taskId)) return;
    const controller = new AbortController();
    this.reviewWaiters.set(taskId, controller);
    void this.reviewLoop(taskId, sessionId, controller.signal);
  }

  /** reviewer 等待器：wait 阻塞到 idle → 结构化 verdict → review-pass / review-escalated（fail-closed）。 */
  async reviewLoop(taskId: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const kernel = this.kernel;
    while (!signal.aborted && kernel.ready && kernel.isLeader()) {
      const t = kernel.projection.tasks.get(taskId);
      if (!t || t.state !== 'REVIEW') { this.reviewWaiters.delete(taskId); return; }
      // 单一 30 分钟窗口（真实项目审查回合数多，实测 10 分钟不足——wait 阻塞语义下足够）
      const outcome = await kernel.hostForSession(sessionId).awaitIdle(sessionId, { timeoutMs: 30 * 60_000, signal });
      if (signal.aborted) return;
      const cur = kernel.projection.tasks.get(taskId);
      if (!cur || cur.state !== 'REVIEW') { this.reviewWaiters.delete(taskId); return; }
      const t2 = kernel.projection.tasks.get(taskId);
      if (!t2 || t2.state !== 'REVIEW') { this.reviewWaiters.delete(taskId); return; }
      if (outcome === 'idle') {
        // verdict 判定（进程内后备，1.4 §3 证伪切换）：
        // reviewer 正常结束（outcome=succeeded）且审查期间未提交任何 question/dcp
        // （那些工具走 ingest，会先把任务拉去 BLOCKED——走到这里即证明零 findings 提交）
        // → 结构性 approve；escalate 语义由 dcae_question/dcp 天然承接（BLOCKED + inbox）。
        const { freezeTask } = await import('../merge/train.ts');
        const sha = t2.worktree ? freezeTask(kernel, taskId, t2.worktree) : null;
        kernel.appendTransition(t2, 'review-pass', { sessionId, frozenRefSha: sha, verdict: 'approve', via: 'structural-zero-findings' });
        kernel.log.info('scheduler', 'reviewer 正常结束且零 findings 提交 → approve', { taskId, sessionId });
        this.reviewWaiters.delete(taskId);
        return;
      }
      // timeout(3 轮上限)/failed/interrupted → escalate（fail-closed）
      const { createInboxItem } = await import('../inbox/inbox.ts');
      createInboxItem(kernel, {
        kind: 'escalation',
        task: taskId,
        question: `审查会话异常终结（outcome=${outcome}）：无法自动判定 verdict，请人工审查后决定。`,
        options: [
          { id: 'proceed', label: '人工判读后继续（保留证据）' },
          { id: 'revalidate', label: '重跑审查' },
          { id: 'cancel', label: '取消任务' },
        ],
      });
      kernel.appendTransition(t2, 'review-escalated', { sessionId, outcome });
      this.reviewWaiters.delete(taskId);
      return;
    }
    this.reviewWaiters.delete(taskId);
  }

  /** ACCEPTED 任务逐节合并（串行；merge-ok/merge-fail/rebase-conflict 由 MergeTrain 追加）。 */
  async runMergeTrain(): Promise<void> {
    if (this.merging) return;
    const accepted = [...this.kernel.projection.tasks.values()].filter((t) => t.state === 'ACCEPTED').sort((a, b) => a.id.localeCompare(b.id));
    if (accepted.length === 0) return;
    this.merging = true;
    try {
      const { mergeOne } = await import('../merge/train.ts');
      for (const t of accepted) {
        if (this.kernel.projection.tasks.get(t.id)?.state !== 'ACCEPTED') continue;
        await mergeOne(this.kernel, t.id);
      }
    } catch (e) {
      this.kernel.log.error('scheduler', '合并列车异常', { error: String(e) });
    } finally {
      this.merging = false;
    }
  }
}

async function collectProvisionalEvidence(kernel: Kernel, taskId: string, sessionId: string): Promise<void> {
  // diff 非空才采集候选诊断证据（provisional，不构成验收依据——原则 4）
  try {
    const t = kernel.projection.tasks.get(taskId);
    if (!t?.worktree) return;
    const { currentSha } = await import('../util/git.ts');
    const sha = currentSha(t.worktree);
    const { spawnSync } = await import('node:child_process');
    const { resolveArgv0 } = await import('../util/argv-resolve.ts');
    const r = spawnSync(resolveArgv0('git'), ['diff', 'HEAD', '--stat'], { cwd: t.worktree, shell: false, encoding: 'utf8' });
    if (!r.stdout || r.stdout.trim() === '') return;
    const { EvidenceStore } = await import('../evidence/store.ts');
    const store = new EvidenceStore(kernel.dcaeDir);
    const ev = store.put({
      task: taskId, attempt: t.attempt, kind: 'check', commit: sha ?? '', base: '',
      run: { cmd: 'diagnostic-diff', args: [] }, exit: 0, result: 'pass',
      startedAt: new Date().toISOString(), durationMs: 0,
      stdout: Buffer.from(r.stdout), stderr: Buffer.from(r.stderr ?? ''), runner: 'host', provisional: true,
    });
    kernel.appendMarkForTask(kernel.projection.tasks.get(taskId)!, 'evidence-recorded', { evId: ev.record.id, provisional: true, sessionId });
  } catch (e) {
    kernel.log.warn('scheduler', '候选诊断证据采集失败', { taskId, sessionId, error: String(e) });
  }
}

async function latestMarker(kernel: Kernel, sessionId: string): Promise<'succeeded' | 'failed' | 'interrupted' | null> {
  try {
    const msgs = await kernel.hostForSession(sessionId).sessionMessages(sessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.type === 'idle' && (m.outcome === 'succeeded' || m.outcome === 'failed' || m.outcome === 'interrupted')) {
        return m.outcome as 'succeeded' | 'failed' | 'interrupted';
      }
      if (m.type === 'user') return null;
    }
  } catch { return null; }
  return null;
}

function depsMerged(kernel: Kernel, def: import('../schema/task.ts').TaskDef): boolean {
  return def.deps.every((d) => kernel.projection.tasks.get(d)?.state === 'MERGED');
}
