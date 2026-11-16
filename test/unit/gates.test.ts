import { describe, test, expect } from 'bun:test';
import { buildStepArgv } from '../../src/gates/runner.ts';
import type { GatesConfig } from '../../src/schema/gates.ts';

const gates: GatesConfig = {
  schema_version: 1,
  runner: 'host',
  commands: {
    test: { argv: ['bun', 'test'], arg_globs: ['src/**', 'acceptance/**'] },
    typecheck: { argv: ['bun', 'run', 'typecheck'] },
  },
  pipeline: [],
  global: [],
  invariants_run: 'never',
  probe_argv0: [],
  output_cap_kb: 256,
};

describe('GateRunner argv 构建（1.4 §6.3：argv 空间、glob 展开、元字符拒绝）', () => {
  const cwd = import.meta.dir; // 有文件的目录
  test('字面量参数须匹配 arg_globs（匹配即通过）', () => {
    const ok = buildStepArgv(gates, { cmd: 'test', args: ['src/foo.test.ts'] }, cwd);
    expect(ok.ok).toBe(true); // src/foo.test.ts 匹配 src/**（字面量不查存在性；glob 形态才展开）
    if (ok.ok) expect(ok.argv).toEqual(['bun', 'test', 'src/foo.test.ts']);
  });
  test('字面量不匹配 arg_globs → 校验失败不执行', () => {
    const r = buildStepArgv(gates, { cmd: 'test', args: ['etc/passwd'] }, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('arg_globs');
  });
  test('glob 展开为空 → 校验失败不执行', () => {
    const r = buildStepArgv(gates, { cmd: 'test', args: ['nope/**/*.ts'] }, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('展开为空');
  });
  test('元字符参数被拒（纵深防御回归）', () => {
    const r = buildStepArgv(gates, { cmd: 'test', args: ['a;b'] }, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('元字符');
  });
  test('未定义命令 id 拒绝（planner 无法引入新可执行文件）', () => {
    const r = buildStepArgv(gates, { cmd: 'unknown', args: [] }, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('未定义');
  });
  test('无 arg_globs 的命令接受任意字面量', () => {
    const r = buildStepArgv(gates, { cmd: 'typecheck', args: [] }, cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toEqual(['bun', 'run', 'typecheck']);
  });
});
