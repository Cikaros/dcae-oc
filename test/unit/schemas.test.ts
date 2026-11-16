import { describe, test, expect } from 'bun:test';
import { TaskSchema, PROTECTED_PATHS } from '../../src/schema/task.ts';
import { parseGates, flattenPipeline, ARG_ELEMENT_RE } from '../../src/schema/gates.ts';
import { InboxItemSchema, inboxFileName } from '../../src/schema/inbox.ts';
import { redact } from '../../src/evidence/redact.ts';
import { sha256, EvidenceStore } from '../../src/evidence/store.ts';
import { parseSpecFile } from '../../src/schema/spec.ts';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(import.meta.dir, '.tmp-schema');

describe('任务 schema（1.4 §6.2：未知字段拒绝）', () => {
  test('合法任务', () => {
    const r = TaskSchema.safeParse({
      schema_version: 1,
      id: 'T-AUTH-001',
      objective: '实现令牌刷新',
      spec_refs: ['SPEC-AUTH'],
      deps: [],
      role: 'dev',
      scope: { write: ['src/auth/**'], shell: ['test'] },
      blind_tests: true,
      blind_test: { attempts: 2, minutes: 15 },
      checks: [{ id: 'c1', run: { cmd: 'test', args: ['acceptance/x.ts'] }, covers: ['REQ-1'] }],
      budget: { attempts: 3, tokens: 400000, minutes: 30, review_cycles: 1 },
    });
    expect(r.success).toBe(true);
  });
  test('未知字段拒绝（strictObject）', () => {
    const r = TaskSchema.safeParse({ schema_version: 1, id: 'T-A-1', objective: 'x', hack: true });
    expect(r.success).toBe(false);
  });
  test('保护路径清单（原则 2 对象）', () => {
    expect(PROTECTED_PATHS).toContain('specs/**');
    expect(PROTECTED_PATHS).toContain('.dcae/**');
  });
});

describe('gates schema（1.4 §6.3：元字符禁令）', () => {
  const okYaml = `
schema_version: 1
runner: host
commands:
  test: { argv: ['bun', 'test'], arg_globs: ['src/**', 'acceptance/**'] }
pipeline: [[typecheck], test]
global: []
probe_argv0: []
output_cap_kb: 256
`;
  test('合法 gates + 管线展开', () => {
    const r = parseGates(okYaml);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const steps = flattenPipeline(r.gates.pipeline);
      expect(steps).toEqual([{ cmd: 'typecheck', args: [] }, { cmd: 'test', args: [] }]);
    }
  });
  test('argv 含 shell 元字符被拒（CI 契约：元字符参数必须被拒）', () => {
    const bad = `
schema_version: 1
commands:
  evil: { argv: ['sh', '-c', 'rm -rf /'] }
`;
    const r = parseGates(bad);
    expect(r.ok).toBe(false);
  });
  test('ARG_ELEMENT_RE 直接判定', () => {
    expect(ARG_ELEMENT_RE.test('bun')).toBe(true);
    expect(ARG_ELEMENT_RE.test('src/**')).toBe(true);
    expect(ARG_ELEMENT_RE.test('a;b')).toBe(false);
    expect(ARG_ELEMENT_RE.test('$(whoami)')).toBe(false);
    expect(ARG_ELEMENT_RE.test('a b')).toBe(false);
  });
});

describe('inbox schema（1.4 §6.8）', () => {
  test('合法项 + 文件名六位补零', () => {
    const r = InboxItemSchema.safeParse({
      schema_version: 1,
      id: 'INBOX-000007',
      kind: 'spec-approval',
      ref: { spec: 'SPEC-AUTH' },
      question: '批准？',
      options: [{ id: 'approve', label: '批准' }],
      created_at: '2026-11-16T09:00:00Z',
      sla_minutes: 240,
    });
    expect(r.success).toBe(true);
    expect(inboxFileName(7)).toBe('INBOX-000007.yaml');
  });
});

describe('脱敏（密钥永不写入；哈希前先跑脱敏模式）', () => {
  test('常见密钥形态替换', () => {
    const out = redact('key=sk-abcdefghijklmnop123456 token: ghp_' + 'a'.repeat(36));
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).toContain('[REDACTED]');
  });
  test('普通文本不受影响', () => {
    expect(redact('tests passed: 42')).toBe('tests passed: 42');
  });
});

describe('证据存储（内容寻址 blob + provisional 语义）', () => {
  test('put → blob 去重 + 记录索引 + 脱敏后哈希', () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const store = new EvidenceStore(TMP);
    const a = store.put({
      task: 'T-1', attempt: 1, kind: 'check', commit: 'abc', base: 'def',
      run: { cmd: 'test', args: [] }, exit: 1, result: 'fail',
      startedAt: '2026-11-16T00:00:00Z', durationMs: 5,
      stdout: Buffer.from('SECRET sk-abcdefghijklmnop123456'), stderr: Buffer.from('err'),
      runner: 'host',
    });
    expect(a.record.provisional).toBe(false);
    expect(a.stdoutSha).toBe(sha256('SECRET [REDACTED]'));
    expect(store.blob(a.stdoutSha)).toBe('SECRET [REDACTED]');
    // 内容寻址去重
    const b = store.put({
      task: 'T-1', attempt: 1, kind: 'check', commit: 'abc', base: 'def',
      run: { cmd: 'test', args: [] }, exit: 1, result: 'fail',
      startedAt: '2026-11-16T00:00:00Z', durationMs: 6,
      stdout: Buffer.from('SECRET sk-abcdefghijklmnop123456'), stderr: Buffer.from('err'),
      runner: 'host', provisional: true,
    });
    expect(b.stdoutSha).toBe(a.stdoutSha);
    expect(b.record.provisional).toBe(true);
    expect(store.get(b.record.id)).not.toBeNull();
  });
});

describe('规范 front-matter（1.4 §6.1）', () => {
  test('解析 + 字段校验', () => {
    const r = parseSpecFile(`---
schema_version: 1
id: SPEC-AUTH
type: design
status: approved
approved_by: alice
approved_at: 2026-11-16
refs: [REQ-AUTH-004]
supersedes: []
---
# 内容
`);
    expect('errors' in r).toBe(false);
    if (!('errors' in r)) {
      expect(r.front.status).toBe('approved');
      expect(r.front.refs).toEqual(['REQ-AUTH-004']);
    }
  });
});
