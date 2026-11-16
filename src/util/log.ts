/**
 * 结构化 JSONL 日志（架构设计 §11）—— .dcae/logs/kernel.log（rotation 10MB ×5）。
 */
import { appendFileSync, existsSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const KEEP = 5;

export class Logger {
  constructor(
    private file: string | null,
    private minLevel: LogLevel = 'info',
  ) {}

  static forDir(dir: string | null, minLevel: LogLevel = 'info'): Logger {
    return new Logger(dir ? join(dir, 'kernel.log') : null, minLevel);
  }

  log(level: LogLevel, module: string, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const rec = { ts: new Date().toISOString(), level, module, msg, ...(data !== undefined ? { data } : {}) };
    const line = JSON.stringify(rec);
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        rotateIfNeeded(this.file);
        appendFileSync(this.file, line + '\n');
      } catch {
        // 日志失败不阻塞业务
      }
    }
    if (this.minLevel === 'debug' || level === 'error') {
      try { console.error(line); } catch { /* noop */ }
    }
  }

  debug(module: string, msg: string, data?: unknown) { this.log('debug', module, msg, data); }
  info(module: string, msg: string, data?: unknown) { this.log('info', module, msg, data); }
  warn(module: string, msg: string, data?: unknown) { this.log('warn', module, msg, data); }
  error(module: string, msg: string, data?: unknown) { this.log('error', module, msg, data); }
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_LOG_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // 尽力而为
  }
}
