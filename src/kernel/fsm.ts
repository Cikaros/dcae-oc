/**
 * TaskFSM —— 事件溯源、带守卫迁移（1.4 §7.1；架构设计 §7）。
 * TABLE 以 Record<State,…> 声明穷尽十二态；守卫纯函数（只读投影，无 IO）；
 * 副作用全部在事件提交后的 effect 层。逐行对照 1.4 §7.1 迁移表 25 行。
 */
import type { State } from '../schema/event.ts';

export type Trigger =
  | 'plan-approved'
  | 'deps-merged'
  | 'test-submit'
  | 'test-exhausted'
  | 'dispatch'
  | 'dcae_submit'
  | 'gate-fail'
  | 'gate-pass'
  | 'gate-exhausted'
  | 'review-pass'
  | 'review-rework'
  | 'review-escalated'
  | 'merge-ok'
  | 'merge-fail'
  | 'rebase-conflict'
  | 'execution-failed'
  | 'execution-interrupted'
  | 'budget-time'
  | 'idle-no-submit'
  | 'session-lost'
  | 'closure-invalidated'
  | 'read-audit'
  | 'auto-restore'
  | 'keep-evidence'
  | 'revalidate'
  | 'cancel'
  | 'retry'
  | 'dep-restored'
  | 'decision-applied'
  | 'question'
  | 'dcp-pending'
  | 'dep-failed';

export interface GuardContext {
  attempt: number;
  attemptsLeft: number;
  /** 本次提交的会话与投影中登记的会话是否匹配（dcae_submit 守卫）。 */
  sessionMatches: boolean;
  /** 失败签名是否为未见过的（gate-fail 守卫）。 */
  signatureNew: boolean;
  /** 范围检查与保护哈希是否干净（gate-pass 守卫）。 */
  scopeClean: boolean;
  /** 有无 open 且 verifiable 的 high finding（review-pass 守卫）。 */
  hasOpenVerifiableHigh: boolean;
  reviewCycles: number;
  reviewRounds: number;
  blindTests: boolean;
  testerBudgetAvailable: boolean;
  planApproved: boolean;
  /** INVALIDATED 自动恢复：变更集与直接影响集无交集且相关规范均 approved。 */
  invalidationNoIntersection: boolean;
  /** dep-failed 恢复：依赖已 MERGED。 */
  depsMerged: boolean;
  /** 决策目标状态（decision-applied 用）。 */
  decisionRestoreState: State | null;
  /** BLOCKED 原因（dep-restored 仅 dep-failed 自动恢复）。 */
  blockedReason: string | null;
}

export type GuardVerdict = { pass: true } | { pass: false; detail: string };

export type TransitionTarget = Exclude<State, 'PENDING'>;

interface T {
  to: TransitionTarget;
  guard?: (c: GuardContext) => GuardVerdict;
}

/** 迁移表：逐行对照 1.4 §7.1（25 行）。`'*'` 键 = 任意状态行；同 trigger 多行 = 按序首中。 */
export const TABLE: Record<State | '*', Partial<Record<Trigger, T | T[]>>> = {
  PENDING: {
    // 1.4 §7.1 前两行：PENDING→TEST_WRITING（blind）/ PENDING→READY（非 blind）
    'deps-merged': [
      {
        to: 'TEST_WRITING',
        guard: (c) => (c.blindTests && c.testerBudgetAvailable && c.planApproved ? { pass: true } : { pass: false, detail: 'blind/预算/批准不满足' }),
      },
      {
        to: 'READY',
        guard: (c) => (!c.blindTests && c.planApproved ? { pass: true } : { pass: false, detail: '非 blind 且计划已批准' }),
      },
    ],
  },
  TEST_WRITING: {
    'test-submit': { to: 'READY' }, // 守卫（读审计通过、哈希已记录）在 effect 执行后由内核判定
    'test-exhausted': { to: 'BLOCKED' },
  },
  READY: {
    dispatch: { to: 'RUNNING' }, // 守卫（worktree/会话/哈希/prompt admit）在 dispatch 序列完成后成立
  },
  RUNNING: {
    dcae_submit: { to: 'VERIFYING', guard: (c) => (c.sessionMatches ? { pass: true } : { pass: false, detail: 'attempt 与会话不匹配' }) },
    'execution-failed': { to: 'FAILED' },
    'execution-interrupted': { to: 'FAILED' },
    'budget-time': { to: 'FAILED' },
    'idle-no-submit': { to: 'FAILED' },
    'session-lost': { to: 'FAILED' },
  },
  VERIFYING: {
    'gate-fail': { to: 'RUNNING', guard: (c) => (c.attemptsLeft > 0 && c.signatureNew ? { pass: true } : { pass: false, detail: '无剩余 attempt 或重复签名' }) },
    'gate-pass': { to: 'REVIEW', guard: (c) => (c.scopeClean ? { pass: true } : { pass: false, detail: '范围检查/保护哈希不干净' }) },
    'gate-exhausted': { to: 'FAILED' },
  },
  REVIEW: {
    'review-pass': { to: 'ACCEPTED', guard: (c) => (!c.hasOpenVerifiableHigh ? { pass: true } : { pass: false, detail: '存在 open 且 verifiable 的 high finding' }) },
    'review-rework': {
      to: 'RUNNING',
      guard: (c) => (c.reviewRounds < c.reviewCycles ? { pass: true } : { pass: false, detail: '超出 budget.review_cycles' }),
    },
    'review-escalated': { to: 'BLOCKED' },
  },
  ACCEPTED: {
    'merge-ok': { to: 'MERGED' },
    'merge-fail': { to: 'FAILED' },
    'rebase-conflict': { to: 'BLOCKED' },
  },
  MERGED: {},
  FAILED: {
    retry: { to: 'READY' }, // 新 attempt epoch（1.4 §6.8）
  },
  BLOCKED: {
    'dep-restored': { to: 'READY', guard: (c) => (c.blockedReason === 'dep-failed' && c.depsMerged ? { pass: true } : { pass: false, detail: '非 dep-failed 或依赖未 MERGED' }) },
    'decision-applied': {
      to: 'READY',
      guard: (c) => (c.decisionRestoreState !== null ? { pass: true } : { pass: false, detail: '决策未指定恢复状态' }),
    },
  },
  INVALIDATED: {
    'auto-restore': { to: 'READY', guard: (c) => (c.invalidationNoIntersection ? { pass: true } : { pass: false, detail: '变更集与直接影响集有交集' }) },
    'keep-evidence': { to: 'VERIFYING' },
    revalidate: { to: 'TEST_WRITING' },
    cancel: { to: 'CANCELLED' },
  },
  CANCELLED: {},
  '*': {
    'closure-invalidated': { to: 'INVALIDATED' },
    cancel: { to: 'CANCELLED' },
    question: { to: 'BLOCKED' },
    'dcp-pending': { to: 'BLOCKED' },
    'dep-failed': { to: 'BLOCKED' },
  },
};

/** BLOCKED 决策恢复映射（1.4 §7.1 原因与恢复表）：决策 → 恢复目标。 */
export function decisionRestore(kind: string, option: string, cur: State): State | null {
  switch (kind) {
    case 'question': {
      if (option === 'proceed') return cur === 'RUNNING' ? 'RUNNING' : 'READY';
      if (option === 'cancel') return null; // 由 cancel trigger 走
      return 'READY';
    }
    case 'escalation':
    case 'revalidation': {
      if (option === 'revalidate') {
        // 重跑审查（escalation 的语境是审查异常终结）；盲测重写走 revalidation 类项
        return 'REVIEW';
      }
      if (option === 'proceed') return 'VERIFYING'; // 人工"保留证据继续"（重跑门禁）
      if (option === 'cancel') return null;
      return 'REVIEW';
    }
    case 'test-exhausted': {
      if (option === 'retry') return 'TEST_WRITING';
      if (option === 'manual') return 'TEST_WRITING';
      if (option === 'cancel') return null;
      return 'TEST_WRITING';
    }
    case 'rebase-conflict': {
      if (option === 'new-baseline') return 'READY'; // 新基线重试（新 attempt）
      if (option === 'manual') return 'READY';
      if (option === 'cancel') return null;
      return 'READY';
    }
    case 'dcp': {
      return 'READY';
    }
    default:
      return 'READY';
  }
}

export interface TransitionOutcome {
  ok: boolean;
  from: State;
  to?: TransitionTarget;
  detail?: string;
}

/**
 * 查表求一次迁移。专用态无表项时回落 `'*'` 行（任意态行）。
 * 非法迁移（两处都无）→ 类型化拒绝，不可达。
 */
export function transition(state: State, trigger: Trigger, c: GuardContext, decisionTo?: State | null): TransitionOutcome {
  const specific = TABLE[state]?.[trigger];
  const wildcard = TABLE['*']![trigger];
  const rule = specific ?? wildcard;
  if (!rule) return { ok: false, from: state, detail: `非法迁移：${state} --${trigger}--> ?` };
  const rules = Array.isArray(rule) ? rule : [rule];
  let lastFail: string | undefined;
  for (const r of rules) {
    const g = r.guard ?? (() => ({ pass: true as const }));
    const v = g(c);
    if (v.pass) {
      const to = (trigger === 'decision-applied' && decisionTo ? decisionTo : r.to) as TransitionTarget;
      return { ok: true, from: state, to };
    }
    lastFail = v.detail;
  }
  return { ok: false, from: state, detail: lastFail ?? 'guard 拒绝' };
}

/** 工作态集合（question/dcp/dep-failed 进入 BLOCKED 的合法起点）。 */
export const WORKING_STATES: readonly State[] = ['PENDING', 'TEST_WRITING', 'READY', 'RUNNING', 'VERIFYING', 'REVIEW', 'ACCEPTED', 'INVALIDATED'];
