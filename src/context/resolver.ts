/**
 * ContextResolver —— 分层、限额的上下文包（1.4 §5.1；架构设计 §3.14）。
 * 层：① 协议块（AGENTS.md）② 任务定义 ③ 已批准规范闭包 ④ 代码标注摘录 ⑤ 失败签名/provisional 摘要。
 * 产出两形态：dispatch instruction entry（≤256 KiB）与 dcae_context_pull 按需切片。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../kernel/kernel.ts';
import type { TaskDef } from '../schema/task.ts';
import type { Role } from '../policy/compile.ts';

export const ENTRY_LIMIT_BYTES = 256 * 1024; // 1.4 §2 #5 [S]

export function buildContextEntry(kernel: Kernel, task: TaskDef, role: Role): string {
  const layers: string[] = [];
  // ① 协议块（AGENTS.md 协议部分，截断到 8 KiB）
  const agents = join(kernel.opts.canonical, 'AGENTS.md');
  if (existsSync(agents)) {
    layers.push('<context key="dcae.protocol">' + readFileSync(agents, 'utf8').slice(0, 8 * 1024) + '</context>');
  }
  // ② 任务定义
  layers.push(`<context key="dcae.task">\n${yamlTaskSummary(task)}\n</context>`);
  // ③ 已批准规范闭包（approved 才入包，1.4 §6.1）
  const specs = approvedSpecBodies(kernel, task);
  if (specs) layers.push(`<context key="dcae.specs">\n${specs}\n</context>`);
  // ⑤ 上一次 attempt 的失败签名与 provisional 证据摘要
  const t = kernel.projection.task(task.id);
  if (t.attempt > 1) {
    const sigs = t.gateFailSignatures.slice(-3).join(', ');
    layers.push(`<context key="dcae.history">attempt ${t.attempt - 1} 失败签名：${sigs || '（无）'}。避免重复同类失败。</context>`);
  }
  const text = layers.join('\n');
  if (Buffer.byteLength(text) > ENTRY_LIMIT_BYTES) {
    // 超限：丢协议块保任务与规范（编译期拒绝在 putInstruction；此处预算内收敛）
    const trimmed = layers.slice(1).join('\n');
    return trimmed.slice(0, ENTRY_LIMIT_BYTES - 64);
  }
  return text;
}

function yamlTaskSummary(task: TaskDef): string {
  return [
    `id: ${task.id}`,
    `objective: ${task.objective}`,
    `spec_refs: [${task.spec_refs.join(', ')}]`,
    `scope.write: [${task.scope.write.join(', ')}]`,
    `scope.shell: [${task.scope.shell.join(', ')}]`,
    `checks: ${task.checks.map((c) => c.id).join(', ')}`,
    `budget: attempts=${task.budget.attempts} minutes=${task.budget.minutes}`,
  ].join('\n');
}

function approvedSpecBodies(kernel: Kernel, task: TaskDef): string {
  const parts: string[] = [];
  for (const id of task.spec_refs) {
    const file = findSpecFile(join(kernel.opts.canonical, 'specs'), id);
    if (!file) continue;
    const text = readFileSync(file, 'utf8');
    if (!/^\s*status:\s*approved/m.test(text.slice(0, 600))) continue; // draft 不入包
    parts.push(`## ${id}\n${text.replace(/^---[\s\S]*?---\n/, '').slice(0, 16 * 1024)}`);
  }
  return parts.join('\n').slice(0, 128 * 1024);
}

function findSpecFile(dir: string, specId: string): string | null {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = `${cur}/${e}`;
      if (statSync(p).isDirectory()) stack.push(p);
      else if (e.endsWith('.md') && readFileSync(p, 'utf8').slice(0, 400).includes(`id: ${specId}`)) return p;
    }
  }
  return null;
}

/** dcae_context_pull { want } —— 预算内切片（字符预算换算 token 估算，可配置）。 */
export function resolvePull(kernel: Kernel, task: TaskDef, want: string, budgetChars = 24_000): string {
  const sections: string[] = [];
  const w = want.toLowerCase();
  const add = (title: string, text: string): void => {
    if (sections.join('\n').length + text.length > budgetChars) return;
    sections.push(`## ${title}\n${text}`);
  };
  if (w.includes('spec') || w.includes('全部')) add('已批准规范', approvedSpecBodies(kernel, task) || '（无 approved 规范）');
  if (w.includes('check') || w.includes('门禁')) {
    add('checks', task.checks.map((c) => `- ${c.id}: ${c.run.cmd} ${c.run.args.join(' ')} → covers ${c.covers.join(',')}`).join('\n'));
  }
  if (w.includes('证据') || w.includes('evidence')) {
    const t = kernel.projection.task(task.id);
    add('近期事件', kernel.eventLog.all().filter((e) => e.task === task.id).slice(-20).map((e) => `- [${e.seq}] ${e.reason} ${e.from}→${e.to}`).join('\n') || '（无）');
    void t;
  }
  if (sections.length === 0) add('任务摘要', yamlTaskSummary(task));
  return sections.join('\n\n').slice(0, budgetChars);
}
