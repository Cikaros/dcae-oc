/**
 * Reconciler —— 重启或 reload 后重建真相（1.4 §5.1/§6.2/§7.2；架构设计 §6.6）。
 * ① 孤儿 RUNNING 归置（优先读会话元数据的 task/attempt 盖章）
 * ② epoch 审计与隔离（倒挂后缀 → quarantine.jsonl + inbox 告警；副作用标记归宿）
 * ③ saved approvals 漂移审计（领导权变更必审 + 低频周期复核，决议 D-1）
 */
import { appendJsonl, readJsonl } from '../util/jsonl.ts';
import { join } from 'node:path';
import type { Kernel } from './kernel.ts';
import { createInboxItem } from '../inbox/inbox.ts';

export class Reconciler {
  constructor(private kernel: Kernel) {}

  async run(): Promise<void> {
    this.auditEpochInversion();
    await this.reconcileOrphanRunning();
    await this.auditSavedApprovals();
  }

  /** epoch 倒挂审计：更高 epoch 之后出现更低 epoch 的事件 → 后缀隔离。 */
  private auditEpochInversion(): void {
    const inv = this.kernel.eventLog.findEpochInversion();
    if (!inv) return;
    const qFile = join(this.kernel.dcaeDir, 'state', 'quarantine.jsonl');
    const quarantined = this.kernel.eventLog.all().filter((e) => e.seq >= inv.at);
    for (const e of quarantined) appendJsonl(qFile, e);
    this.kernel.appendMark('epoch-quarantined', { from: inv.at, count: quarantined.length });
    this.kernel.log.error('reconciler', 'epoch 倒挂：事件后缀已隔离', { from: inv.at, count: quarantined.length });
    createInboxItem(this.kernel, {
      kind: 'escalation',
      question: `事件日志发现 epoch 倒挂（seq ${inv.at} 起 ${quarantined.length} 条已隔离到 quarantine.jsonl）。被隔离事件的宿主副作用（已 dispatch 的会话、已创建的 worktree）不做回滚，请人工归置。`,
      options: [
        { id: 'acknowledge', label: '已知悉，按记录归置' },
        { id: 'inspect', label: '先检查再决定' },
      ],
    });
  }

  /** 孤儿 RUNNING 处置（1.4 §7.2 表；归置优先读会话元数据）。 */
  private async reconcileOrphanRunning(): Promise<void> {
    for (const t of this.kernel.projection.tasks.values()) {
      if (t.state !== 'RUNNING' && t.state !== 'TEST_WRITING') continue;
      if (!t.sessionId) {
        this.kernel.appendTransition(t, 'session-lost', { detail: '无会话 ID（dispatch 未完成即中断）' });
        continue;
      }
      let s;
      try {
        s = await this.kernel.host().getSession(t.sessionId);
      } catch (e) {
        this.kernel.log.warn('reconciler', '会话查询失败（HostPort 不可用，保持 RUNNING 待下轮）', { task: t.id, error: String(e) });
        continue;
      }
      // 元数据优先：dispatch 盖章的 task/attempt（1.4 §7.2）
      const metaTask = s.metadata && typeof s.metadata.task === 'string' ? s.metadata.task : null;
      if (metaTask && metaTask !== t.id) {
        // 目录/元数据均不符 → 归属他任务：本任务 FAILED attempt
        this.kernel.appendTransition(t, 'session-lost', { detail: `会话元数据归属 ${metaTask}` });
        continue;
      }
      if (!s.exists || (s.directory && t.worktree && normalize(s.directory) !== normalize(t.worktree))) {
        this.kernel.appendTransition(t, 'session-lost', { detail: '会话不存在或目录不符（worktree 保留供检查）' });
        continue;
      }
      if (s.active) {
        // 以最后已确认 admission 为基准重建 awaitIdle（Scheduler 心跳会补挂）
        this.kernel.log.info('reconciler', '孤儿 RUNNING：会话活跃，等待器交由 Scheduler 重建', { task: t.id });
        continue;
      }
      if (s.outcome === 'failed' || s.outcome === 'interrupted') {
        this.kernel.appendTransition(t, s.outcome === 'failed' ? 'execution-failed' : 'execution-interrupted', { sessionId: t.sessionId, via: 'reconciler' });
        continue;
      }
      // 非活跃且无终结标记 → idle：按无提交空闲规则推进（计入提醒计数）
      this.kernel.appendMarkForTask(t, 'idle-nudge', { via: 'reconciler', sessionId: t.sessionId });
    }
    await this.reconcileOrphanWorktrees();
  }

  /** 孤儿 worktree 归置：不属于任何 RUNNING/TEST_WRITING 任务的 dcae-* worktree 记录待清理。 */
  private async reconcileOrphanWorktrees(): Promise<void> {
    try {
      const { worktreeList } = await import('../util/git.ts');
      const wts = worktreeList(this.kernel.opts.canonical);
      const activeWorktrees = new Set(
        [...this.kernel.projection.tasks.values()]
          .filter((t) => t.state === 'RUNNING' || t.state === 'TEST_WRITING')
          .map((t) => (t.worktree ? normalize(t.worktree) : '')),
      );
      const orphans = wts.filter((w) => normalize(w) !== normalize(this.kernel.opts.canonical) && /\/dcae-/.test(w) && !activeWorktrees.has(normalize(w)));
      if (orphans.length > 0) {
        this.kernel.log.info('reconciler', '孤儿 worktree（由 dcae CLI clean 或按任务状态归置）', { orphans });
        this.kernel.appendMark('worktree-removed', { orphans, pending: true });
      }
    } catch { /* 非 git 或 worktree 列举失败：跳过 */ }
  }

  /** saved approvals 漂移审计（T-s；deny 不受影响，allow 面漂移升级 inbox）。 */
  async auditSavedApprovals(): Promise<void> {
    let saved;
    try {
      saved = await this.kernel.host().savedApprovals();
    } catch (e) {
      this.kernel.log.debug('reconciler', 'savedApprovals 不可用（跳过本轮审计）', { error: String(e) });
      return;
    }
    const known = new Set(this.kernel.projection.knownSavedApprovals.map((k) => `${k.action}\u0000${k.resource}`));
    const fresh = [];
    for (const s of saved) {
      const key = `${String(s.action ?? '')}\u0000${String(s.resource ?? '')}`;
      if (!known.has(key)) fresh.push(s);
    }
    if (fresh.length > 0) {
      this.kernel.appendMark('saved-approval-drift', { added: fresh });
      this.kernel.projection.knownSavedApprovals.push(...fresh.map((f) => ({ action: String(f.action ?? ''), resource: String(f.resource ?? '') })));
      this.kernel.log.warn('reconciler', 'saved approvals 新增（宿主交互期间批准的 allow 面漂移）', { count: fresh.length });
      createInboxItem(this.kernel, {
        kind: 'escalation',
        question: `saved approvals 新增 ${fresh.length} 条（${fresh.slice(0, 3).map((f) => `${f.action}:${f.resource}`).join('、')}…）。这些项目级 allow 会被内核自有会话命中（deny 不受影响）。`,
        options: [
          { id: 'accept', label: '接受（记入已知清单）' },
          { id: 'revoke', label: '要求人工撤销后重审' },
        ],
      });
    }
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

// 事件日志直接读取接口（供 CLI verify）
export function readAllEvents(kernel: Kernel) {
  return readJsonl(join(kernel.dcaeDir, 'state', 'events.jsonl'));
}
