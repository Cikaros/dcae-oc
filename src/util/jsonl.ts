/**
 * JSONL 追加与重放（events.jsonl / quarantine.jsonl）—— 架构设计 §3.3。
 * 追加即 fsync（1.4 §6.5："append-only，每行一个 JSON 对象，追加即 fsync"）。
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendJsonl(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + '\n';
  const fd = openSync(file, 'a');
  try {
    appendFileSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // 尾部半行（崩溃中断）：跳过——事件日志以完整行为准
    }
  }
  return out;
}

export function fileSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}
