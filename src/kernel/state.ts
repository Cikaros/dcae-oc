/**
 * StateProjection —— 事件重放的内存投影（架构设计 §3.6）。
 * 由 snapshot（uptoSeq 前状态）+ 其后事件重放构建；seenKeys 从事件 data.key 重建。
 */
import type { DcaeEvent, State } from '../schema/event.ts';
import { SnapshotSchema, type Snapshot, type TaskRuntime } from '../schema/snapshot.ts';

export class Projection {
  tasks = new Map<string, TaskRuntime>();
  seenKeys = new Set<string>();
  knownSavedApprovals: { action: string; resource: string; effect?: string }[] = [];
  uptoSeq = 0;
  inboxSeq = 0;

  task(id: string): TaskRuntime {
    let t = this.tasks.get(id);
    if (!t) {
      t = {
        id,
        state: 'PENDING',
        attempt: 1,
        blockedReason: null,
        sessionId: null,
        reviewSessionId: null,
        worktree: null,
        admissionId: null,
        idleNudges: 0,
        waitContinuations: 0,
        gateFailSignatures: [],
        reviewRounds: 0,
        budgetUsed: { tokens: 0, costUsd: 0 },
        closureHash: null,
        frozenSha: null,
        lastTestCommitHash: null,
        dispatchAt: null,
      };
      this.tasks.set(id, t);
    }
    return t;
  }

  /** 从事件流应用一条（投影推进）。 */
  apply(e: DcaeEvent): void {
    this.uptoSeq = e.seq;
    const key = (e.data as any)?.key;
    if (typeof key === 'string') this.seenKeys.add(key);
    if (e.task === '*') {
      if (e.reason === 'leader-acquired') {
        const known = (e.data as any)?.knownSavedApprovals;
        if (Array.isArray(known)) this.knownSavedApprovals = known;
      }
      return;
    }
    // 幽灵事件防护（实测缺陷已复现）：空 task id 的事件（历史/外来会话的 question/question 等）不得
    // 在投影中建立任务——否则 dcae status 出现空行、收件箱 ref.task="" 无法恢复任何任务。
    if (!e.task) return;
    const t = this.task(e.task);
    switch (e.reason) {
      case 'plan-approved':
        t.state = 'PENDING';
        break;
      case 'deps-merged':
        t.state = e.to;
        break;
      case 'test-submit':
        t.state = 'READY';
        break;
      case 'test-exhausted':
        this.toBlocked(t, 'test-exhausted');
        break;
      case 'dispatch': {
        const d = (e.data ?? {}) as any;
        if (e.from === e.to) {
          // tester/reviewer dispatch 标记：只记会话，不迁移状态
          if (d.role === 'reviewer') t.reviewSessionId = d.sessionId ?? null;
          else if (d.role === 'tester') t.sessionId = d.sessionId ?? null;
          break;
        }
        t.state = 'RUNNING';
        t.sessionId = d.sessionId ?? null;
        t.worktree = d.worktree ?? null;
        t.admissionId = d.admissionId ?? null;
        t.attempt = Number(d.attempt ?? t.attempt);
        t.closureHash = d.closureHash ?? null;
        t.dispatchAt = e.ts;
        t.idleNudges = 0;
        break;
      }
      case 'dcae_submit':
        t.state = 'VERIFYING';
        break;
      case 'gate-fail':
        t.state = 'RUNNING';
        t.attempt += 0; // 同 attempt 重入（gate-fail 不消耗 attempt；消耗发生在 FAILED）
        if (typeof (e.data as any)?.signature === 'string') t.gateFailSignatures.push((e.data as any).signature);
        break;
      case 'gate-pass':
        t.state = 'REVIEW';
        t.reviewSessionId = null;
        break;
      case 'gate-exhausted':
      case 'execution-failed':
      case 'execution-interrupted':
      case 'budget-time':
      case 'idle-no-submit':
      case 'session-lost':
      case 'merge-fail':
        t.state = 'FAILED';
        t.attempt += 1; // 消耗一次 attempt
        break;
      case 'review-pass': {
        t.state = 'ACCEPTED';
        const d = (e.data ?? {}) as any;
        if (typeof d?.frozenRefSha === 'string') t.frozenSha = d.frozenRefSha;
        break;
      }
      case 'review-rework':
        t.state = 'RUNNING';
        t.reviewRounds += 1;
        break;
      case 'review-escalated':
        this.toBlocked(t, 'review-escalated');
        break;
      case 'rebase-conflict':
        this.toBlocked(t, 'rebase-conflict');
        break;
      case 'merge-ok':
        t.state = 'MERGED';
        break;
      case 'closure-invalidated':
        t.state = 'INVALIDATED';
        break;
      case 'read-audit':
        t.state = 'TEST_WRITING';
        break;
      case 'auto-restore':
        t.state = 'READY';
        break;
      case 'keep-evidence':
        t.state = 'VERIFYING';
        break;
      case 'revalidate':
        t.state = 'TEST_WRITING';
        break;
      case 'cancel':
        t.state = 'CANCELLED';
        break;
      case 'retry':
        t.state = 'READY';
        break;
      case 'dep-restored':
        t.state = 'READY';
        t.blockedReason = null;
        break;
      case 'decision-applied': {
        const d = (e.data ?? {}) as any;
        if (d?.restore) t.state = d.restore;
        t.blockedReason = null;
        break;
      }
      case 'question':
        this.toBlocked(t, 'question');
        break;
      case 'dcp-pending':
        this.toBlocked(t, 'dcp-pending');
        break;
      case 'dep-failed':
        this.toBlocked(t, 'dep-failed');
        break;
      case 'test-committed': {
        const d = (e.data ?? {}) as any;
        if (typeof d?.hash === 'string') t.lastTestCommitHash = d.hash;
        break;
      }
      case 'idle-nudge':
        t.idleNudges += 1;
        break;
      case 'wait-continued':
        t.waitContinuations += 1;
        break;
      case 'reminder-injected':
        t.idleNudges += 0;
        break;
      default:
        break;
    }
  }

  private toBlocked(t: TaskRuntime, reason: string): void {
    t.state = 'BLOCKED' as State;
    t.blockedReason = reason;
  }

  /** 快照装载。 */
  loadSnapshot(raw: unknown): boolean {
    const r = SnapshotSchema.safeParse(raw);
    if (!r.success) return false;
    const snap: Snapshot = r.data;
    this.uptoSeq = snap.uptoSeq;
    this.inboxSeq = snap.tasks.length; // 近似；inbox 序号由目录扫描修正
    for (const t of snap.tasks) this.tasks.set(t.id, structuredClone(t));
    this.seenKeys = new Set(snap.seenKeys);
    this.knownSavedApprovals = snap.knownSavedApprovals.map((x) => ({ action: x.action, resource: x.resource, effect: x.effect }));
    return true;
  }

  toSnapshot(epoch: number): Snapshot {
    return {
      schema_version: 1,
      epoch,
      uptoSeq: this.uptoSeq,
      savedAt: new Date().toISOString(),
      tasks: [...this.tasks.values()].map((t) => structuredClone(t)),
      seenKeys: [...this.seenKeys],
      knownSavedApprovals: this.knownSavedApprovals.map((x) => ({ action: x.action, resource: x.resource, effect: 'allow' as const })),
    };
  }
}
