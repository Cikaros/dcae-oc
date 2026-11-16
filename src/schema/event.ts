/**
 * 事件信封与 reason 全集 —— 架构设计 §5.2（1.4 §6.5：append-only events.jsonl）。
 * 命名两类：1.4 逐字名 / 实现扩展名（评审 P2-9 后的显式区分）。
 */
import { z } from 'zod';

export const TASK_ANY = '*';

/** 状态全集（1.4 §7.1 十二态）。 */
export const STATES = [
  'PENDING', 'TEST_WRITING', 'READY', 'RUNNING', 'VERIFYING', 'REVIEW',
  'ACCEPTED', 'MERGED', 'FAILED', 'BLOCKED', 'INVALIDATED', 'CANCELLED',
] as const;
export type State = (typeof STATES)[number];
export const StateSchema = z.enum(STATES);

/** BLOCKED 原因（1.4 §7.1 原因表六项，逐字）。 */
export const BLOCKED_REASONS = [
  'dep-failed', 'question', 'review-escalated', 'rebase-conflict', 'test-exhausted', 'dcp-pending',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * reason 全集。
 * 1.4 逐字名：dcae_submit, execution-failed, execution-interrupted, budget-time,
 *   idle-no-submit, session-lost, read-audit, auto-restore, dep-failed, idle-nudge,
 *   unattended-ask-denied, sla-notify, test-exhausted, review-escalated, rebase-conflict,
 *   question, dcp-pending。
 * 其余为实现扩展（事件溯源完备性）。
 */
export const REASONS = [
  // 迁移类
  'plan-approved', 'deps-merged', 'test-submit', 'test-exhausted', 'dispatch',
  'dcae_submit', 'gate-fail', 'gate-pass', 'gate-exhausted',
  'review-pass', 'review-rework', 'review-escalated',
  'merge-ok', 'merge-fail', 'rebase-conflict',
  'execution-failed', 'execution-interrupted', 'budget-time', 'idle-no-submit', 'session-lost',
  'closure-invalidated', 'read-audit', 'auto-restore', 'keep-evidence', 'revalidate', 'cancel',
  'retry', 'dep-restored', 'decision-applied', 'dep-failed', 'question', 'dcp-pending',
  // 标记类（from == to）
  'idle-nudge', 'unattended-ask-denied', 'sla-notify',
  'leader-acquired', 'leader-lost', 'saved-approval-drift',
  'evidence-recorded', 'worktree-created', 'worktree-removed',
  'frozen-ref', 'test-committed', 'wait-continued', 'epoch-quarantined',
  'reminder-injected',
] as const;
export type Reason = (typeof REASONS)[number];
export const ReasonSchema = z.enum(REASONS);

/** dispatch 事件 data（架构设计 §3.8）。 */
export const DispatchDataSchema = z.object({
  sessionId: z.string(),
  worktree: z.string(),
  forkSha: z.string(),
  admissionId: z.string(),
  closureHash: z.string(),
  attempt: z.number().int().positive(),
  role: z.string(),
});
export type DispatchData = z.infer<typeof DispatchDataSchema>;

/** 事件信封（1.4 §6.5 示例逐字字段 + 实现补充 data）。 */
export const EventSchema = z.object({
  seq: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
  ts: z.string(),
  task: z.string(), // '*' 表内核级
  from: StateSchema,
  to: StateSchema,
  reason: ReasonSchema,
  actor: z.string(), // 'kernel' | 'human:<name>' | 'session:<id>'
  data: z.unknown().optional(),
});
export type DcaeEvent = z.infer<typeof EventSchema>;
export type DraftEvent = Omit<DcaeEvent, 'seq' | 'epoch' | 'ts'>;

/** 构造草稿事件的辅助。 */
export function draftEvent(
  task: string,
  from: State,
  to: State,
  reason: Reason,
  actor = 'kernel',
  data?: unknown,
): DraftEvent {
  return { task, from, to, reason, actor, ...(data !== undefined ? { data } : {}) };
}
