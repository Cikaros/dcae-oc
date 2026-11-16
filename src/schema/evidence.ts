/**
 * 证据记录 schema —— 1.4 §6.4（内容寻址 blob + 索引记录）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common.ts';

export const EvidenceKindSchema = z.enum(['check', 'invariant', 'scope', 'review', 'clean-room', 'merge', 'probe']);
export const EvidenceResultSchema = z.enum(['pass', 'fail', 'error', 'timeout']);

export const RunRefSchema = z.object({ cmd: z.string(), args: z.array(z.string()).default([]) });
export type RunRef = z.infer<typeof RunRefSchema>;

export const EvidenceRecordSchema = z.strictObject({
  schema_version: SchemaVersion,
  id: z.string().regex(/^ev_[0-9A-Z]{10,26}$/),
  task: z.string(),
  attempt: z.number().int().positive(),
  kind: EvidenceKindSchema,
  /** 被验证的提交；merge 类为合并后集成分支提交。 */
  commit: z.string(),
  base: z.string(),
  run: RunRefSchema,
  exit: z.number().int(),
  result: EvidenceResultSchema,
  started_at: z.string(),
  duration_ms: z.number().int().nonnegative(),
  stdout_sha256: z.string(),
  stderr_sha256: z.string(),
  runner: z.enum(['host', 'container']),
  /** true = 候选诊断证据，不构成验收依据（1.4 §6.4）。 */
  provisional: z.boolean().default(false),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

/** review finding（1.4 §7.4）。 */
export const FindingVerifySchema = z.union([
  z.object({ cmd: z.string(), args: z.array(z.string()).default([]) }),
  z.object({ probe: z.object({ argv: z.array(z.string()).min(1), expect: z.enum(['fail', 'pass']) }) }),
]);

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
  claim: z.string(),
  file: z.string().optional(),
  verify: FindingVerifySchema.optional(),
  /** 内核执行后的判定。 */
  status: z.enum(['open', 'advisory', 'fixed', 'invalid']).optional(),
  signature: z.string().optional(),
});

export const ReviewVerdictSchema = z.enum(['approve', 'request_changes', 'escalate']);

/** review 类证据的 blob 附加结构。 */
export const ReviewPayloadSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  verdict: ReviewVerdictSchema,
  summary: z.string().default(''),
});
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;
