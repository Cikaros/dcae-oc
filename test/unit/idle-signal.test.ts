import { describe, test, expect } from 'bun:test';
import { parseIdleEvent } from '../../src/kernel/idle-signal.ts';

/**
 * 回归覆盖：awaitIdle 的进程内 idle 信号解析。
 * 缺陷（2026-11-17，已复现）：早期实现读 e.properties / e.data.properties，
 * 而平台负载为 { type, data: { sessionID } } → 正常结束的审查会话无法识别，
 * REVIEW 只能等满 30 分钟窗口超时升级。此处锁定平台的逐字取值路径。
 */
describe('parseIdleEvent（平台事件 → 会话信号）', () => {
  test('session.idle：sessionID 取自 data（平台 schema，非 properties）', () => {
    expect(parseIdleEvent({ type: 'session.idle', data: { sessionID: 'ses_abc' } })).toEqual({
      sessionID: 'ses_abc',
      signal: 'idle',
    });
  });

  test('session.execution.succeeded → idle；failed/interrupted 分别映射', () => {
    expect(parseIdleEvent({ type: 'session.execution.succeeded', data: { sessionID: 's1' } })).toEqual({ sessionID: 's1', signal: 'idle' });
    expect(parseIdleEvent({ type: 'session.execution.failed', data: { sessionID: 's1' } })).toEqual({ sessionID: 's1', signal: 'failed' });
    expect(parseIdleEvent({ type: 'session.execution.interrupted', data: { sessionID: 's1' } })).toEqual({ sessionID: 's1', signal: 'interrupted' });
  });

  test('旧错误形态（properties 域）不再被识别——防回退', () => {
    expect(parseIdleEvent({ type: 'session.idle', properties: { sessionID: 'ses_abc' } })).toBeNull();
    expect(parseIdleEvent({ type: 'session.idle', data: { properties: { sessionID: 'ses_abc' } } })).toBeNull();
  });

  test('非终结类 / 缺字段 / 非法输入 → null', () => {
    expect(parseIdleEvent({ type: 'session.text.delta', data: { sessionID: 's1' } })).toBeNull();
    expect(parseIdleEvent({ type: 'session.idle' })).toBeNull();
    expect(parseIdleEvent({ type: 'session.idle', data: { sessionID: 42 } })).toBeNull();
    expect(parseIdleEvent(null)).toBeNull();
    expect(parseIdleEvent('nope')).toBeNull();
  });
});
