import { describe, test, expect } from 'bun:test';
import { transition, TABLE, decisionRestore, type GuardContext } from '../../src/kernel/fsm.ts';
import { TARGET_OF } from '../../src/kernel/targets.ts';
import { STATES, REASONS } from '../../src/schema/event.ts';
import type { State } from '../../src/schema/event.ts';

const G: GuardContext = {
  attempt: 1,
  attemptsLeft: 2,
  sessionMatches: true,
  signatureNew: true,
  scopeClean: true,
  hasOpenVerifiableHigh: false,
  reviewCycles: 1,
  reviewRounds: 0,
  blindTests: true,
  testerBudgetAvailable: true,
  planApproved: true,
  invalidationNoIntersection: true,
  depsMerged: true,
  decisionRestoreState: null,
  blockedReason: null,
};

describe('TaskFSM（1.4 §7.1 迁移表 25 行逐行）', () => {
  test('十二态在 TABLE 全部声明（穷尽性）', () => {
    for (const s of STATES) expect(TABLE[s]).toBeDefined();
  });

  // PENDING 两行（同 trigger 双目标：按序首中）
  test('PENDING→TEST_WRITING（blind+tester 预算+计划批准）/ PENDING→READY（非 blind）', () => {
    expect(transition('PENDING', 'deps-merged', G).ok).toBe(true);
    expect(transition('PENDING', 'deps-merged', G).to).toBe('TEST_WRITING');
    const r = transition('PENDING', 'deps-merged', { ...G, blindTests: false });
    expect(r.ok).toBe(true);
    expect(r.to).toBe('READY');
    // 计划未批准：两行都拒
    expect(transition('PENDING', 'deps-merged', { ...G, planApproved: false }).ok).toBe(false);
  });

  // TEST_WRITING 两行
  test('TEST_WRITING→READY（test-submit）/ →BLOCKED（test-exhausted）', () => {
    expect(transition('TEST_WRITING', 'test-submit', G).ok).toBe(true);
    expect(transition('TEST_WRITING', 'test-exhausted', G).ok).toBe(true);
  });

  // READY 一行
  test('READY→RUNNING（dispatch）', () => {
    expect(transition('READY', 'dispatch', G).ok).toBe(true);
  });

  // RUNNING 四行（+ FAILED 三原因）
  test('RUNNING→VERIFYING（dcae_submit，attempt 匹配守卫）', () => {
    expect(transition('RUNNING', 'dcae_submit', G).ok).toBe(true);
    expect(transition('RUNNING', 'dcae_submit', { ...G, sessionMatches: false }).ok).toBe(false);
  });
  test('RUNNING→FAILED 三原因（execution-failed/interrupted/budget-time）', () => {
    expect(transition('RUNNING', 'execution-failed', G).ok).toBe(true);
    expect(transition('RUNNING', 'execution-interrupted', G).ok).toBe(true);
    expect(transition('RUNNING', 'budget-time', G).ok).toBe(true);
    expect(transition('RUNNING', 'idle-no-submit', G).ok).toBe(true);
    expect(transition('RUNNING', 'session-lost', G).ok).toBe(true);
  });

  // VERIFYING 三行
  test('VERIFYING→RUNNING（gate-fail：attempts 余量 + 签名新）', () => {
    expect(transition('VERIFYING', 'gate-fail', G).ok).toBe(true);
    expect(transition('VERIFYING', 'gate-fail', { ...G, signatureNew: false }).ok).toBe(false);
    expect(transition('VERIFYING', 'gate-fail', { ...G, attemptsLeft: 0 }).ok).toBe(false);
  });
  test('VERIFYING→REVIEW（gate-pass，范围干净守卫）', () => {
    expect(transition('VERIFYING', 'gate-pass', G).ok).toBe(true);
    expect(transition('VERIFYING', 'gate-pass', { ...G, scopeClean: false }).ok).toBe(false);
  });
  test('VERIFYING→FAILED（gate-exhausted）', () => {
    expect(transition('VERIFYING', 'gate-exhausted', G).ok).toBe(true);
  });

  // REVIEW 三行
  test('REVIEW→ACCEPTED（无 open+verifiable high）', () => {
    expect(transition('REVIEW', 'review-pass', G).ok).toBe(true);
    expect(transition('REVIEW', 'review-pass', { ...G, hasOpenVerifiableHigh: true }).ok).toBe(false);
  });
  test('REVIEW→RUNNING（rework，review_cycles 唯一上限）', () => {
    expect(transition('REVIEW', 'review-rework', G).ok).toBe(true);
    expect(transition('REVIEW', 'review-rework', { ...G, reviewRounds: 1, reviewCycles: 1 }).ok).toBe(false);
  });
  test('REVIEW→BLOCKED（escalate）', () => {
    expect(transition('REVIEW', 'review-escalated', G).ok).toBe(true);
  });

  // ACCEPTED 三行
  test('ACCEPTED 三出边（merge-ok/fail/rebase-conflict）', () => {
    expect(transition('ACCEPTED', 'merge-ok', G).ok).toBe(true);
    expect(transition('ACCEPTED', 'merge-fail', G).ok).toBe(true);
    expect(transition('ACCEPTED', 'rebase-conflict', G).ok).toBe(true);
  });

  // 任意行（INVALIDATED / CANCELLED / question / dcp-pending / dep-failed）
  test('任意态：closure-invalidated / cancel / question / dep-failed', () => {
    for (const s of ['RUNNING', 'VERIFYING', 'REVIEW', 'ACCEPTED', 'READY'] as State[]) {
      expect(transition(s, 'closure-invalidated', G).ok).toBe(true);
      expect(transition(s, 'cancel', G).ok).toBe(true);
      expect(transition(s, 'question', G).ok).toBe(true);
      expect(transition(s, 'dep-failed', G).ok).toBe(true);
    }
  });

  // INVALIDATED 四出边
  test('INVALIDATED 四出边（auto-restore/keep-evidence/revalidate/cancel）', () => {
    expect(transition('INVALIDATED', 'auto-restore', G).ok).toBe(true);
    expect(transition('INVALIDATED', 'auto-restore', { ...G, invalidationNoIntersection: false }).ok).toBe(false);
    expect(transition('INVALIDATED', 'keep-evidence', G).ok).toBe(true);
    expect(transition('INVALIDATED', 'revalidate', G).ok).toBe(true);
    expect(transition('INVALIDATED', 'cancel', G).ok).toBe(true);
  });

  // BLOCKED 恢复
  test('BLOCKED：dep-restored 仅 dep-failed 且依赖 MERGED；decision-applied 需恢复目标', () => {
    expect(transition('BLOCKED', 'dep-restored', { ...G, blockedReason: 'dep-failed' }).ok).toBe(true);
    expect(transition('BLOCKED', 'dep-restored', { ...G, blockedReason: 'question' }).ok).toBe(false);
    expect(transition('BLOCKED', 'dep-restored', { ...G, blockedReason: 'dep-failed', depsMerged: false }).ok).toBe(false);
    expect(transition('BLOCKED', 'decision-applied', { ...G, decisionRestoreState: 'READY' }, 'READY').ok).toBe(true);
    expect(transition('BLOCKED', 'decision-applied', G).ok).toBe(false);
  });

  // FAILED→READY
  test('FAILED→READY（retry 新 attempt）', () => {
    expect(transition('FAILED', 'retry', G).ok).toBe(true);
  });

  // 非法迁移不可达
  test('非法迁移被拒（MERGED 终态；跨态乱连）', () => {
    expect(transition('MERGED', 'dispatch', G).ok).toBe(false);
    expect(transition('CANCELLED', 'retry', G).ok).toBe(false);
    expect(transition('PENDING', 'dcae_submit', G).ok).toBe(false);
    expect(transition('READY', 'gate-pass', G).ok).toBe(false);
  });

  test('targets：迁移目标与 1.4 表一致', () => {
    expect(TARGET_OF.dcae_submit!(null as never)).toBe('VERIFYING');
    expect(TARGET_OF['gate-pass']!(null as never)).toBe('REVIEW');
    expect(TARGET_OF['budget-time']!(null as never)).toBe('FAILED');
    expect(TARGET_OF['read-audit']!(null as never)).toBe('TEST_WRITING');
  });

  test('reason 枚举含 1.4 逐字名', () => {
    for (const r of ['dcae_submit', 'execution-failed', 'execution-interrupted', 'budget-time', 'idle-no-submit', 'session-lost', 'read-audit', 'auto-restore', 'dep-failed', 'idle-nudge', 'unattended-ask-denied', 'sla-notify', 'test-exhausted', 'review-escalated', 'rebase-conflict', 'question', 'dcp-pending'] as const) {
      expect(REASONS.includes(r)).toBe(true);
    }
  });

  test('决策恢复映射（1.4 §7.1 BLOCKED 原因与恢复表）', () => {
    expect(decisionRestore('escalation', 'revalidate', 'BLOCKED')).toBe('REVIEW'); // 重跑审查（非盲任务）
    expect(decisionRestore('escalation', 'proceed', 'BLOCKED')).toBe('VERIFYING');
    expect(decisionRestore('question', 'cancel', 'BLOCKED')).toBeNull();
    expect(decisionRestore('rebase-conflict', 'new-baseline', 'BLOCKED')).toBe('READY');
  });
});
