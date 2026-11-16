/**
 * HostPort —— 平台变动隔离的唯一边界（1.4 §5.4 逐字接口；原则 9）。
 * 适配器实现见 host/opencode.ts；所有 OpenCode 访问必须经此接口。
 */

export interface Rule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export interface SessionInfo {
  id: string;
  directory?: string;
  title?: string;
  agent?: string;
  metadata?: Record<string, unknown>;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  tokens?: Tokens;
  costUsd?: number;
}

export interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  exit: number | null; // null = 被信号/超时终止
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  durationMs: number;
}

export interface SessionLogItem {
  seq: number;
  ts?: string;
  type?: string;
  data?: unknown;
}

export interface SavedApproval {
  id?: string;
  action?: string;
  resource?: string;
  [k: string]: unknown;
}

export class HostUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: 'no-instance' | 'no-http-base' | 'http-error' | 'unsupported',
  ) {
    super(message);
    this.name = 'HostUnavailable';
  }
}

/** 1.4 §5.4 逐字接口（notify 已移除——server 插件无用户通知 API [D]）。 */
export interface HostPort {
  createSession(i: {
    id: string;
    directory: string;
    agent: string;
    title: string;
    permissions?: Rule[]; // 创建时原子施加（[A]；优先于此后的 setPermissions）
    metadata?: Record<string, unknown>; // task/attempt 盖章（[A]；Reconciler 孤儿归置依据）
    parentID?: string;
    model?: { id: string; providerID: string; variant?: string };
  }): Promise<SessionInfo>;

  /** session.update 权限规则集（替换式）[A]。 */
  setPermissions(id: string, rules: Rule[]): Promise<void>;

  /** PUT environment，整体替换 [A]。 */
  setEnvironment(id: string, env: Record<string, string>): Promise<void>;

  /** 实验性 entries；单值 ≤256 KiB [S]，后备在内。 */
  putInstruction(id: string, key: string, value: unknown): Promise<void>;

  prompt(
    id: string,
    text: string,
    o: { messageId: string; delivery?: 'steer' | 'queue' },
  ): Promise<{ messageId: string }>;

  /**
   * 平台 wait 无请求体（[A]）；本方法 = wait() 包超时 + 会话日志尾部 Idle 标记（outcome）判定（§7.2）。
   * 标记与 admission 的先后核对在内核层（1.4 §7.2）。
   */
  awaitIdle(id: string, o: { timeoutMs: number; signal: AbortSignal }): Promise<'idle' | 'failed' | 'interrupted' | 'timeout'>;

  /** [A] resume 语义。 */
  interrupt(id: string, resume?: boolean): Promise<void>;

  /** experimental.session.log（[A]）；读审计（§6.6）与 idle 定位（§7.2）依赖。 */
  sessionLog(id: string, after?: number, o?: { follow?: boolean }): AsyncIterable<SessionLogItem>;

  /** 一次性读取日志尾部（awaitIdle/读审计的便捷形态）。 */
  sessionLogTail(id: string, lastN?: number): Promise<SessionLogItem[]>;

  getSession(id: string): Promise<{
    exists: boolean;
    active: boolean;
    directory: string;
    tokens: Tokens;
    costUsd: number;
    outcome?: 'succeeded' | 'failed' | 'interrupted'; // [A] Session.Info
    metadata?: Record<string, unknown>; // [A] dispatch 盖章回读
    agent?: string;
    raw?: unknown;
  }>;

  /** [D] create 输入 {projectID, from?, branch?, directory?, name?}。 */
  createWorktree(projectID: string, name: string, o?: { from?: string; branch?: string }): Promise<{ directory: string }>;

  /** [D] 三参数全必填。 */
  removeWorktree(projectID: string, directory: string, force: boolean): Promise<void>;

  /** 直接 spawn，不经 shell（V1 $ 辅助已移除 [D]）。 */
  exec(cmd: string[], o: ExecOptions): Promise<ExecResult>;

  /** /api/permission/saved 只读审计（[A]；§6.2）。 */
  savedApprovals(): Promise<SavedApproval[]>;

  appVersion(): string;
}
