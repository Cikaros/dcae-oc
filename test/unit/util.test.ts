import { describe, test, expect } from 'bun:test';
import { dcaeGlobMatch, expandGlob, matchesAny } from '../../src/util/glob.ts';
import { ulid, sessionId, messageId } from '../../src/util/ulid.ts';
import { atomicWrite } from '../../src/util/atomic-write.ts';
import { appendJsonl, readJsonl } from '../../src/util/jsonl.ts';
import { normalizeForMatch, matchKey, joinPosix, hasParentTraversal } from '../../src/util/paths.ts';
import { resolveArgv0 } from '../../src/util/argv-resolve.ts';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(import.meta.dir, '.tmp-util');

function freshTmp(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  return TMP;
}

describe('DCAE glob 语义（1.4 §6.2 全局统一）', () => {
  test('* 不跨 /', () => {
    expect(dcaeGlobMatch('src/*.ts', 'src/a.ts')).toBe(true);
    expect(dcaeGlobMatch('src/*.ts', 'src/sub/a.ts')).toBe(false);
  });
  test('** 跨 /', () => {
    expect(dcaeGlobMatch('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(dcaeGlobMatch('src/**', 'src/x')).toBe(true);
  });
  test('X/** 匹配 X 自身与其下', () => {
    expect(dcaeGlobMatch('src/**', 'src')).toBe(true);
    expect(dcaeGlobMatch('src/**', 'srcx')).toBe(false);
  });
  test('? 单字符', () => {
    expect(dcaeGlobMatch('a?c', 'abc')).toBe(true);
    expect(dcaeGlobMatch('a?c', 'abbc')).toBe(false);
  });
  test('字面量与锚定', () => {
    expect(dcaeGlobMatch('bc', 'xbc')).toBe(false);
    expect(dcaeGlobMatch('specs/**', 'specs/drafts/SPEC-A.md')).toBe(true);
  });
  test('matchesAny', () => {
    expect(matchesAny(['a/**', 'b/**'], 'b/c')).toBe(true);
  });
});

describe('glob 展开（GateRunner，展开为空即校验失败）', () => {
  test('展开具体文件', () => {
    const dir = freshTmp();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'x');
    writeFileSync(join(dir, 'src', 'b.ts'), 'x');
    const out = expandGlob('src/*.ts', dir);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
  test('展开为空 → 空数组', () => {
    const dir = freshTmp();
    expect(expandGlob('src/**/*.nope', dir)).toEqual([]);
  });
  test('非通配存在即自身', () => {
    const dir = freshTmp();
    writeFileSync(join(dir, 'f.ts'), 'x');
    expect(expandGlob('f.ts', dir)).toEqual(['f.ts']);
    expect(expandGlob('nope.ts', dir)).toEqual([]);
  });
});

describe('ulid / 会话 ID / 消息 ID', () => {
  test('ULID 单调且 26 字符', () => {
    let prev = '';
    for (let i = 0; i < 50; i++) {
      const u = ulid(1000);
      expect(u.length).toBe(26);
      expect(u >= prev).toBe(true);
      prev = u;
    }
  });
  test('sessionId 完整形态 ses_ + 26 字母数字（降序 ULID，实测平台要求前缀）', () => {
    const s = sessionId();
    expect(s).toMatch(/^ses_[A-Z0-9]{26}$/);
  });
  test('messageId ^msg_', () => {
    expect(messageId()).toMatch(/^msg_[A-Z0-9]{26}$/);
  });
});

describe('原子写与 JSONL', () => {
  test('temp+rename 原子覆盖', () => {
    const dir = freshTmp();
    const f = join(dir, 'x.json');
    atomicWrite(f, '{"a":1}');
    atomicWrite(f, '{"a":2}');
    expect(readFileSyncSafe(f)).toBe('{"a":2}');
    // 无残留 tmp 文件
    const leftovers = readdirSafe(dir).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
  test('jsonl 追加 + 重放（尾部半行跳过）', () => {
    const dir = freshTmp();
    const f = join(dir, 'e.jsonl');
    appendJsonl(f, { a: 1 });
    appendJsonl(f, { a: 2 });
    appendFileSyncRaw(f, '{"a":3'); // 模拟崩溃半行
    const rows = readJsonl<{ a: number }>(f);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('路径归一化', () => {
  test('POSIX 化与 matchKey', () => {
    expect(normalizeForMatch('a\\b\\c')).toBe('a/b/c');
    expect(normalizeForMatch('a//b/')).toBe('a/b');
    expect(matchKey('A\\B')).toBe(matchKey('a/b'));
  });
  test('joinPosix / 遍历检测', () => {
    expect(joinPosix('a', 'b', 'c.ts')).toBe('a/b/c.ts');
    expect(hasParentTraversal('a/../b')).toBe(true);
    expect(hasParentTraversal('a/b')).toBe(false);
  });
});

describe('argv[0] 解析（Windows shim EINVAL 规避）', () => {
  test('PATH 中的命令解析为绝对路径', () => {
    const r = resolveArgv0(process.platform === 'win32' ? 'git' : 'sh');
    expect(r.includes('/')).toBe(true);
    expect(existsSync(r)).toBe(true);
  });
  test('不存在的命令原样返回（fail-visible）', () => {
    expect(resolveArgv0('definitely-not-a-real-cmd-xyz')).toBe('definitely-not-a-real-cmd-xyz');
  });
});

function readFileSyncSafe(f: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(f, 'utf8');
}
function readdirSafe(d: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(d);
}
function appendFileSyncRaw(f: string, text: string): void {
  const { appendFileSync } = require('node:fs') as typeof import('node:fs');
  appendFileSync(f, text);
}
