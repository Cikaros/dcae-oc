/**
 * EvidenceStore —— 内容寻址的证据 blob 与索引（1.4 §6.4；架构设计 §3.11）。
 * blob: .dcae/evidence/<sha256>；记录: .dcae/evidence/index/<ev_id>.yaml。
 * provisional: true = 候选诊断证据，不构成验收依据。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write.ts';
import { parse, stringify as stringifyYaml } from 'yaml';
import { ulid } from '../util/ulid.ts';
import { redact } from './redact.ts';
import type { EvidenceRecord } from '../schema/evidence.ts';
import type { RunRef } from '../schema/evidence.ts';

export class EvidenceStore {
  constructor(private dcaeDir: string) {}

  private get blobDir(): string {
    return join(this.dcaeDir, 'evidence');
  }

  private get indexDir(): string {
    return join(this.dcaeDir, 'evidence', 'index');
  }

  put(input: {
    task: string;
    attempt: number;
    kind: EvidenceRecord['kind'];
    commit: string;
    base: string;
    run: RunRef;
    exit: number;
    result: EvidenceRecord['result'];
    startedAt: string;
    durationMs: number;
    stdout: Buffer;
    stderr: Buffer;
    runner: 'host' | 'container';
    provisional?: boolean;
  }): { record: EvidenceRecord; stdoutSha: string; stderrSha: string } {
    const stdoutText = redact(input.stdout.toString('utf8'));
    const stderrText = redact(input.stderr.toString('utf8'));
    const stdoutSha = sha256(stdoutText);
    const stderrSha = sha256(stderrText);
    const record: EvidenceRecord = {
      schema_version: 1,
      id: `ev_${ulid()}`,
      task: input.task,
      attempt: input.attempt,
      kind: input.kind,
      commit: input.commit,
      base: input.base,
      run: input.run,
      exit: input.exit,
      result: input.result,
      started_at: input.startedAt,
      duration_ms: input.durationMs,
      stdout_sha256: stdoutSha,
      stderr_sha256: stderrSha,
      runner: input.runner,
      provisional: input.provisional ?? false,
    };
    // blob 内容寻址（存在即跳过——内容寻址天然幂等）
    const blob = (name: string, text: string) => {
      const p = join(this.blobDir, name);
      if (!existsSync(p)) atomicWrite(p, text);
    };
    blob(stdoutSha, stdoutText);
    blob(stderrSha, stderrText);
    atomicWrite(join(this.indexDir, `${record.id}.yaml`), stringifyYaml(record));
    return { record, stdoutSha, stderrSha };
  }

  get(recordId: string): EvidenceRecord | null {
    const p = join(this.indexDir, `${recordId}.yaml`);
    if (!existsSync(p)) return null;
    try {
      return parse(readFileSync(p, 'utf8')) as EvidenceRecord;
    } catch {
      return null;
    }
  }

  blob(name: string): string | null {
    const p = join(this.blobDir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
