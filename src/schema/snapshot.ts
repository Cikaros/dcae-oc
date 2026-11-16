/**
 * 快照 schema —— 1.4 §6.5（周期性 snapshot.json 加速重启重建）。
 */
import { z } from 'zod';
import { SchemaVersion, RuleSchema } from './common.ts';
import { StateSchema } from './event.ts';

export const TaskRuntimeSchema = z.object({
  id: z.string(),
  state: StateSchema,
  attempt: z.number().int().positive().default(1),
  blockedReason: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  worktree: z.string().nullable().default(null),
  admissionId: z.string().nullable().default(null),
  idleNudges: z.number().int().nonnegative().default(0),
  waitContinuations: z.number().int().nonnegative().default(0),
  gateFailSignatures: z.array(z.string()).default([]),
  reviewRounds: z.number().int().nonnegative().default(0),
  budgetUsed: z.object({ tokens: z.number().default(0), costUsd: z.number().default(0) }).default({ tokens: 0, costUsd: 0 }),
  closureHash: z.string().nullable().default(null),
  frozenSha: z.string().nullable().default(null),
  lastTestCommitHash: z.string().nullable().default(null),
  dispatchAt: z.string().nullable().default(null),
});
export type TaskRuntime = z.infer<typeof TaskRuntimeSchema>;

export const SnapshotSchema = z.object({
  schema_version: SchemaVersion,
  epoch: z.number().int().positive(),
  uptoSeq: z.number().int().nonnegative(),
  savedAt: z.string(),
  tasks: z.array(TaskRuntimeSchema),
  /** 已接受幂等键（重启安全重建源之一；事件日志为另一源）。 */
  seenKeys: z.array(z.string()).default([]),
  /** saved approvals 已知清单（审计对比基线）。 */
  knownSavedApprovals: z.array(RuleSchema).default([]),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
