import { describe, test, expect } from 'bun:test';
import { compile, type CompileEnv } from '../../src/policy/compile.ts';
import { dcaeGlobToPlatform, isSingleSegment } from '../../src/policy/translate.ts';
import type { TaskDef } from '../../src/schema/task.ts';

const baseTask: TaskDef = {
  schema_version: 1,
  id: 'T-TEST-001',
  objective: '测试',
  spec_refs: [],
  deps: [],
  role: 'dev',
  scope: { write: ['src/**'], shell: ['test', 'typecheck'] },
  blind_tests: false,
  acceptance_tests: [],
  checks: [],
  invariants: [],
  budget: { attempts: 3, tokens: 100, minutes: 10, review_cycles: 1 },
  external_read_allow: [],
};

const env: CompileEnv = {
  canonicalDir: 'E:/proj',
  worktreeDir: 'E:/proj/.worktrees/T-TEST-001',
  allWorktreeDirs: ['E:/proj', 'E:/proj/.worktrees/T-OTHER', 'E:/proj/.worktrees/T-TEST-001'],
  commandPrefixes: { test: ['bun', 'test'], typecheck: ['bun', 'run', 'typecheck'] },
};

describe('PolicyCompiler（1.4 §6.2/§6.6；架构设计 §8）', () => {
  test('dev：external_directory deny-all 在列（对抗平台默认 allow，P0）', () => {
    const { rules } = compile(baseTask, 'dev', env);
    expect(rules).toContainEqual({ action: 'external_directory', resource: '*', effect: 'deny' });
  });
  test('dev：shell = deny 全部 + allow 白名单前缀（last-match 序）', () => {
    const { rules } = compile(baseTask, 'dev', env);
    const shell = rules.filter((r) => r.action === 'shell');
    expect(shell[0]).toEqual({ action: 'shell', resource: '*', effect: 'deny' });
    expect(shell).toContainEqual({ action: 'shell', resource: 'bun test *', effect: 'allow' });
    expect(shell).toContainEqual({ action: 'shell', resource: 'bun run typecheck *', effect: 'allow' });
  });
  test('dev：写范围 src/** 译作 src/*（递归 allow 近似）', () => {
    const { rules } = compile(baseTask, 'dev', env);
    expect(rules).toContainEqual({ action: 'edit', resource: 'src/*', effect: 'allow' });
  });
  test('dev：edit deny-all 先于窄 allow（顺序敏感）', () => {
    const { rules } = compile(baseTask, 'dev', env);
    const denyAll = rules.findIndex((r) => r.action === 'edit' && r.resource === '*');
    const allowScope = rules.findIndex((r) => r.action === 'edit' && r.resource === 'src/*');
    expect(denyAll).toBeGreaterThanOrEqual(0);
    expect(allowScope).toBeGreaterThan(denyAll);
  });
  test('dev：subagent 一律 deny', () => {
    const { rules } = compile(baseTask, 'dev', env);
    expect(rules).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
  });
  test('单段写范围不编译为 allow（事后 diff 权威）+ 遥测', () => {
    const { rules, telemetry } = compile({ ...baseTask, scope: { write: ['src/*.ts'], shell: [] } }, 'dev', env);
    expect(rules.find((r) => r.action === 'edit' && r.resource === 'src/*' && r.effect === 'allow')).toBeUndefined();
    expect(telemetry.singleSegmentScope).toContain('src/*.ts');
  });
  test('planner：subagent explore 白名单（先 deny 后 allow）+ 仅 specs/drafts 与 tasks 可写', () => {
    const { rules } = compile(baseTask, 'planner', env);
    const sa = rules.filter((r) => r.action === 'subagent');
    expect(sa[0]).toEqual({ action: 'subagent', resource: '*', effect: 'deny' });
    expect(sa).toContainEqual({ action: 'subagent', resource: 'explore', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'edit', resource: 'specs/drafts/*', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'edit', resource: 'tasks/*', effect: 'allow' });
  });
  test('tester：读隔离双编译（跨 worktree 主防线 + external_directory 项目外）', () => {
    const { rules } = compile(baseTask, 'tester', env);
    const reads = rules.filter((r) => r.action === 'read' && r.effect === 'deny');
    // canonical + 其他 worktree 的绝对形态 deny
    expect(reads.some((r) => r.resource === 'E:/proj/*')).toBe(true);
    expect(reads.some((r) => r.resource === 'E:/proj/.worktrees/T-OTHER/*')).toBe(true);
    // 不 deny 自身 scratch
    expect(reads.some((r) => r.resource === 'E:/proj/.worktrees/T-TEST-001/*')).toBe(false);
    // *..* 相对遍历兜底
    expect(rules).toContainEqual({ action: 'read', resource: '*..*', effect: 'deny' });
    // glob/grep 同形
    expect(rules.filter((r) => r.action === 'glob' && r.effect === 'deny').length).toBeGreaterThan(0);
    expect(rules.filter((r) => r.action === 'grep' && r.effect === 'deny').length).toBeGreaterThan(0);
    // acceptance 写 allow
    expect(rules).toContainEqual({ action: 'edit', resource: 'acceptance/T-TEST-001/*', effect: 'allow' });
  });
  test('reviewer：零写零 shell 零子代理', () => {
    const { rules } = compile(baseTask, 'reviewer', env);
    expect(rules).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' });
    expect(rules).toContainEqual({ action: 'shell', resource: '*', effect: 'deny' });
    expect(rules).toContainEqual({ action: 'subagent', resource: '*', effect: 'deny' });
    expect(rules.every((r) => r.effect !== 'ask')).toBe(true); // 产物不制造 ask
  });
  test('外部只读加白通道（决策应用后注入）', () => {
    const { rules } = compile(baseTask, 'dev', { ...env, externalReadAllow: ['E:/vendor/lib'] });
    expect(rules).toContainEqual({ action: 'read', resource: 'E:/vendor/lib', effect: 'allow' });
  });
});

describe('DCAE glob → 平台翻译（架构设计 §8.2）', () => {
  test('递归 src/** → src/*', () => {
    expect(dcaeGlobToPlatform('src/**')).toBe('src/*');
  });
  test('保护路径 deny 原样保留', () => {
    expect(dcaeGlobToPlatform('specs/**')).toBe('specs/*');
    expect(dcaeGlobToPlatform('gates.yaml')).toBe('gates.yaml');
  });
  test('单段检测', () => {
    expect(isSingleSegment('src/*.ts')).toBe(true);
    expect(isSingleSegment('src/**')).toBe(false);
    expect(isSingleSegment('gates.yaml')).toBe(false);
  });
  test('globstar 模式开关（语义翻转监测）', () => {
    expect(dcaeGlobToPlatform('src/**', { compilerMode: 'globstar' })).toBe('src/**');
  });
});
