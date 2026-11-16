/**
 * inbox 项 schema —— 1.4 §6.8（.dcae/inbox/INBOX-<n>.yaml）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common.ts';
import { parse as yamlParse } from 'yaml';

export const InboxKindSchema = z.enum(['spec-approval', 'question', 'dcp', 'escalation', 'revalidation', 'test-exhausted']);
export type InboxKind = z.infer<typeof InboxKindSchema>;

export const InboxOptionSchema = z.object({ id: z.string().min(1), label: z.string() });

export const InboxItemSchema = z.strictObject({
  schema_version: SchemaVersion,
  id: z.string().regex(/^INBOX-\d{6}$/),
  kind: InboxKindSchema,
  ref: z.object({
    task: z.string().optional(),
    dcp: z.string().optional(),
    spec: z.string().optional(),
  }).default({}),
  question: z.string(),
  options: z.array(InboxOptionSchema).min(1),
  created_at: z.string(),
  sla_minutes: z.number().int().positive(),
  /** 提醒历史（内核追加；从事件日志重建）。 */
  reminders: z.array(z.object({ at: z.string(), stage: z.number().int() })).default([]),
  status: z.enum(['open', 'decided']).default('open'),
  decision: z.object({ option: z.string(), note: z.string().optional(), decided_at: z.string() }).optional(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export function parseInboxItem(text: string): { ok: true; item: InboxItem } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = yamlParse(text);
  } catch (e) {
    return { ok: false, errors: [`YAML 解析失败: ${String(e)}`] };
  }
  const r = InboxItemSchema.safeParse(raw);
  if (r.success) return { ok: true, item: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

export function inboxFileName(n: number): string {
  return `INBOX-${String(n).padStart(6, '0')}.yaml`;
}
