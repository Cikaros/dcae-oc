/**
 * reason → 迁移目标态映射（内核 appendTransition 用；与 fsm.ts TABLE 对齐）。
 */
import type { Reason, State } from '../schema/event.ts';

export type TargetFn = (t: { state: State; blockedReason: string | null }, data?: unknown) => State;

export const TARGET_OF: Partial<Record<Reason, TargetFn>> = {
  'plan-approved': () => 'PENDING',
  'deps-merged': (_t, data) => (data && (data as any).blind ? 'TEST_WRITING' : 'READY'),
  'test-submit': () => 'READY',
  'test-exhausted': () => 'BLOCKED',
  dispatch: () => 'RUNNING',
  dcae_submit: () => 'VERIFYING',
  'gate-fail': () => 'RUNNING',
  'gate-pass': () => 'REVIEW',
  'gate-exhausted': () => 'FAILED',
  'review-pass': () => 'ACCEPTED',
  'review-rework': () => 'RUNNING',
  'review-escalated': () => 'BLOCKED',
  'merge-ok': () => 'MERGED',
  'merge-fail': () => 'FAILED',
  'rebase-conflict': () => 'BLOCKED',
  'execution-failed': () => 'FAILED',
  'execution-interrupted': () => 'FAILED',
  'budget-time': () => 'FAILED',
  'idle-no-submit': () => 'FAILED',
  'session-lost': () => 'FAILED',
  'closure-invalidated': () => 'INVALIDATED',
  'read-audit': () => 'TEST_WRITING',
  'auto-restore': () => 'READY',
  'keep-evidence': () => 'VERIFYING',
  revalidate: () => 'TEST_WRITING',
  cancel: () => 'CANCELLED',
  retry: () => 'READY',
  'dep-restored': () => 'READY',
  question: () => 'BLOCKED',
  'dcp-pending': () => 'BLOCKED',
  'dep-failed': () => 'BLOCKED',
};
