/**
 * 任务文件装载（1.4 §6.2：任务文件永不存储状态）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { TaskSchema, type TaskDef } from '../schema/task.ts';
import { parse as yamlParse } from 'yaml';

export function loadTaskDef(file: string): TaskDef | null {
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    const stripped = text.replace(/^---\s*\r?\n/, '').replace(/\r?\n---\s*$/, '');
    const raw = yamlParse(stripped);
    const r = TaskSchema.safeParse(raw);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function loadAllTaskDefs(dir: string): TaskDef[] {
  if (!existsSync(dir)) return [];
  const out: TaskDef[] = [];
  for (const f of readdirSafe(dir)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    const t = loadTaskDef(`${dir}/${f}`);
    if (t) out.push(t);
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
