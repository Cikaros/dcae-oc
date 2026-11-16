/**
 * Inbox —— 结构化人工决策（1.4 §6.8；架构设计 §3.15）。
 * 项文件 .dcae/inbox/INBOX-<n>.yaml；决策经 decision 邮箱（幂等键 = inbox 项 ID）。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write.ts';
import { InboxItemSchema, inboxFileName, type InboxItem, type InboxKind } from '../schema/inbox.ts';
import { parse as yamlParse, stringify as stringifyYaml } from 'yaml';
import type { Kernel } from '../kernel/kernel.ts';

export function inboxDir(kernel: Kernel): string {
  return join(kernel.dcaeDir, 'inbox');
}

export interface CreateInboxInput {
  kind: InboxKind;
  task?: string;
  spec?: string;
  dcp?: string;
  question: string;
  options: { id: string; label: string }[];
  slaMinutes?: number;
}

export function createInboxItem(kernel: Kernel, input: CreateInboxInput): InboxItem {
  const n = kernel.nextInboxNumber();
  const item: InboxItem = {
    schema_version: 1,
    id: `INBOX-${String(n).padStart(6, '0')}`,
    kind: input.kind,
    ref: { task: input.task, dcp: input.dcp, spec: input.spec },
    question: input.question,
    options: input.options,
    created_at: new Date().toISOString(),
    sla_minutes: input.slaMinutes ?? kernel.config.slaDefaultMinutes,
    reminders: [],
    status: 'open',
  };
  atomicWrite(join(inboxDir(kernel), inboxFileName(n)), stringifyYaml(item));
  return item;
}

export function createQuestionInbox(
  kernel: Kernel,
  task: string,
  question: string,
  options?: { id: string; label: string }[],
): InboxItem {
  return createInboxItem(kernel, {
    kind: 'question',
    task,
    question,
    options: options ?? [
      { id: 'proceed', label: '按建议继续' },
      { id: 'rework', label: '给出新指示' },
      { id: 'cancel', label: '取消该任务' },
    ],
  });
}

export function listInbox(kernel: Kernel): InboxItem[] {
  const dir = inboxDir(kernel);
  if (!existsSync(dir)) return [];
  const out: InboxItem[] = [];
  for (const f of readdirSync(dir).filter((x) => /^INBOX-\d+\.yaml$/.test(x)).sort()) {
    try {
      const r = InboxItemSchema.safeParse(yamlParse(readFileSync(join(dir, f), 'utf8')));
      if (r.success) out.push(r.data);
    } catch { /* 跳过坏项 */ }
  }
  return out;
}

export function loadInboxItem(kernel: Kernel, id: string): InboxItem | null {
  const m = /^INBOX-(\d+)$/.exec(id);
  const file = join(inboxDir(kernel), m ? inboxFileName(Number(m[1])) : `${id}.yaml`);
  if (!existsSync(file)) return null;
  const r = InboxItemSchema.safeParse(yamlParse(readFileSync(file, 'utf8')));
  return r.success ? r.data : null;
}

/** 决策应用（decision 邮箱的消费端效果；幂等键 = inbox 项 ID，由 kernel 去重）。 */
export async function applyDecision(
  kernel: Kernel,
  inboxId: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; detail?: string }> {
  const item = loadInboxItem(kernel, inboxId);
  if (!item) return { ok: false, detail: `inbox 项不存在：${inboxId}` };
  if (item.status === 'decided') return { ok: true, detail: '重复决策（已决定）' };
  const option = String(payload.option ?? '');
  const note = payload.note ? String(payload.note) : undefined;
  const by = payload.by ? String(payload.by) : 'human';

  // 1. 项标记 decided
  item.status = 'decided';
  item.decision = { option, note, decided_at: new Date().toISOString() };
  const m = /^INBOX-(\d+)$/.exec(item.id);
  if (m) {
    atomicWrite(join(inboxDir(kernel), inboxFileName(Number(m[1]))), stringifyYaml(item));
  }

  // 2. spec-approval：写 status: approved 与 approved_by（1.4 §6.8 决策命令集）
  if (item.kind === 'spec-approval' && item.ref.spec && option === 'approve') {
    approveSpec(kernel, item.ref.spec, by);
  }

  // 3. FSM 迁移
  const t = kernel.projection.task(item.ref.task ?? '*');
  if (item.ref.task && t.state === 'BLOCKED') {
    const { decisionRestore } = await import('../kernel/fsm.ts');
    const restore = decisionRestore(item.kind, option, t.state);
    if (option === 'cancel' || restore === null) {
      kernel.appendTransition(t, 'cancel', { inboxId, option });
    } else {
      kernel.appendTransition(t, 'decision-applied', { inboxId, option, kind: item.kind, restore, note });
    }
  } else if (item.kind === 'revalidation' && item.ref.task) {
    if (option === 'revalidate') kernel.appendTransition(t, 'revalidate', { inboxId });
    else if (option === 'proceed') kernel.appendTransition(t, 'keep-evidence', { inboxId });
    else if (option === 'cancel') kernel.appendTransition(t, 'cancel', { inboxId });
  }

  kernel.appendMarkForTask(kernel.projection.task(item.ref.task ?? '*'), 'decision-applied' as never, { inboxId, option });
  return { ok: true, detail: `决策已应用：${item.id} -> ${option}` };
}

/** dcae approve-spec（仅人类通道调用；1.4 §6.1 只有人类决策能把规范变为 approved）。 */
export function approveSpec(kernel: Kernel, specId: string, by: string): boolean {
  const dir = join(kernel.opts.canonical, 'specs');
  const found = findSpecFile(dir, specId);
  if (!found) return false;
  try {
    const text = readFileSync(found, 'utf8');
    const updated = text
      .replace(/^status:\s*draft\s*$/m, 'status: approved')
      .replace(/^status:\s*superseded\s*$/m, 'status: approved');
    const stamped = updated.replace(/(^(?:---\n[\s\S]*?))$/m, `$1`);
    const withBy = /approved_by:/.test(stamped)
      ? stamped.replace(/^approved_by:.*$/m, `approved_by: ${by}`)
      : stamped.replace(/^---$/m, `---\napproved_by: ${by}`);
    const finalText = /approved_at:/.test(withBy)
      ? withBy.replace(/^approved_at:.*$/m, `approved_at: ${new Date().toISOString().slice(0, 10)}`)
      : withBy.replace(/^approved_by:.*$/m, `$&\napproved_at: ${new Date().toISOString().slice(0, 10)}`);
    writeFileSync(found, finalText);
    // 闭包失效检查由 Indexer 在下次 dispatch/审计时增量执行（1.4 §7.3）
    return true;
  } catch {
    return false;
  }
}

function findSpecFile(dir: string, specId: string): string | null {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const f of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, f.name);
      if (f.isDirectory()) stack.push(p);
      else if (f.name.endsWith('.md') && readFileSync(p, 'utf8').slice(0, 400).includes(`id: ${specId}`)) return p;
    }
  }
  return null;
}
