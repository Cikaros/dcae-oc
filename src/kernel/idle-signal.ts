/**
 * 会话 idle/终态事件的纯解析（awaitIdle 的进程内信号来源）。
 *
 * 背景（2026-11-17 实测缺陷，已复现）：平台 `session.idle` 事件负载为
 * `{ type, data: { sessionID } }`（见 @opencode/client SessionIdle / SessionExecution*）。
 * 早期实现误读 `e.properties` / `e.data.properties`，导致 idle 信号从未生效：
 * 正常结束的审查会话无法被识别，REVIEW 闭环只能等满 30 分钟窗口后超时升级为 BLOCKED。
 *
 * 抽为纯函数以便单测直接覆盖该回归（不加载插件运行时）。
 */
export type IdleSignal = 'idle' | 'failed' | 'interrupted';

export interface ParsedIdleEvent {
  sessionID: string;
  signal: IdleSignal;
}

/**
 * 从一条平台事件解析会话信号；非会话终结类事件返回 null。
 * 取值路径与平台 schema 逐字对齐：sessionID 位于 `data.sessionID`。
 */
export function parseIdleEvent(ev: unknown): ParsedIdleEvent | null {
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as { type?: unknown; data?: { sessionID?: unknown } };
  const sessionID = e.data && typeof e.data.sessionID === 'string' ? e.data.sessionID : undefined;
  if (!sessionID || typeof e.type !== 'string') return null;
  switch (e.type) {
    case 'session.idle':
    case 'session.execution.succeeded':
      return { sessionID, signal: 'idle' };
    case 'session.execution.failed':
      return { sessionID, signal: 'failed' };
    case 'session.execution.interrupted':
      return { sessionID, signal: 'interrupted' };
    default:
      return null;
  }
}
