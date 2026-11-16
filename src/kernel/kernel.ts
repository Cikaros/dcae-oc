/**
 * Kernel —— 确定性内核单例（1.4 §5.2/§5.3；架构设计 §3.2）。
 * R7：所有状态变更汇聚 Kernel.ingest()；R8：follower 经邮箱，leader 直处理，同一套检查。
 * 幂等键 ${task}:${session}:${kind}:${seq}（decision = inbox 项 ID）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HostPort, Rule } from '../host/port.ts';
import { DEFAULT_CONFIG, KernelConfig } from '../schema/common.ts';
import { draftEvent, type DcaeEvent, type DraftEvent, type Reason, type State } from '../schema/event.ts';
import { Projection } from './state.ts';
import { EventLog, type LockSnapshot } from './events.ts';
import { Lease, newKernelId } from './lease.ts';
import { consumeAll, doneKeys, enqueue } from './mailbox.ts';
import { Logger } from '../util/log.ts';
import { ulid } from '../util/ulid.ts';
import { decisionRestore, transition, type GuardContext, type Trigger } from './fsm.ts';
import { loadTaskDef } from '../tasks/load.ts';
import type { TaskDef } from '../schema/task.ts';
import { TARGET_OF } from './targets.ts';

export const INGEST_KINDS = ['submit', 'test_submit', 'question', 'dcp', 'decision'] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

export interface IngestRequest {
  kind: IngestKind;
  task: string;
  session: string;
  payload: Record<string, unknown>;
}

export interface IngestResult {
  ok: boolean;
  queued?: 'processed' | 'enqueued' | 'duplicate';
  detail?: string;
  event?: DcaeEvent;
}

export interface KernelOptions {
  canonical: string;
  projectID: string;
  config?: Partial<KernelConfig>;
}

interface HostProvider {
  mkHost: () => HostPort;
  canonical: boolean;
  locationDir?: string;
}

function normalizeDirKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class Kernel {
  readonly kernelId = newKernelId();
  readonly config: KernelConfig;
  readonly log: Logger;
  readonly dcaeDir: string;
  readonly projection = new Projection();
  readonly eventLog: EventLog;
  readonly lease: Lease;
  ready = false;
  private stopped = false;

  /** R6：存活实例的 host 工厂（优先 canonical 实例）。 */
  private hostProviders = new Map<string, HostProvider>();
  /** 会话 → 所在 location 目录（ctx.session 域 per-location——跨实例调用必须路由，实测同 ctx.vcs 限制）。 */
  private sessionLocation = new Map<string, string>();
  /** (task, session, kind) → 下一 seq（幂等键计数器；从事件日志重建）。 */
  private counters = new Map<string, number>();
  private mailboxTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotCounter = 0;
  private snapEpochFloor = 0;
  /** Leader 调度器（首次 leadership 时创建；R4 无租约不运行）。 */
  scheduler: import('./scheduler.ts').Scheduler | null = null;
  /** 唤醒回调（实例事件订阅注册；R5 事件只做唤醒）。 */
  private wakeCallbacks = new Set<() => void>();

  constructor(readonly opts: KernelOptions) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    this.dcaeDir = join(opts.canonical, '.dcae');
    try { mkdirSync(this.dcaeDir, { recursive: true }); } catch { /* 只读场景容忍 */ }
    this.log = Logger.forDir(existsSync(this.dcaeDir) ? join(this.dcaeDir, 'logs') : null, this.config.logLevel);
    const selfRef = { epoch: 0, kernelId: this.kernelId };
    this.lease = new Lease(this.dcaeDir, this.kernelId, (role, epoch) => {
      selfRef.epoch = epoch;
      if (role === 'leader') void this.onLeadershipGained();
      else void this.onLeadershipLost();
    });
    this.eventLog = new EventLog(join(this.dcaeDir, 'state', 'events.jsonl'), {
      readLock: () => this.readLockSnapshot(),
      self: selfRef,
      onGuardFailure: (reason) => {
        this.log.warn('kernel', 'append 守卫失败，降级 follower', { reason });
        this.lease.demote(reason);
      },
    });
  }

  private readLockSnapshot(): LockSnapshot | null {
    const lock = this.lease.readLock();
    if (!lock) return null;
    if (Date.now() - Date.parse(lock.heartbeat_at) > 20_000) return null;
    return { epoch: lock.epoch, holderKernelId: lock.holder.kernelId };
  }

  // ---------- 实例生命周期（R3/R6） ----------

  attachInstance(instanceId: string, mkHost: () => HostPort, isCanonical: boolean, locationDir?: string): void {
    this.hostProviders.set(instanceId, { mkHost, canonical: isCanonical, locationDir: locationDir ? normalizeDirKey(locationDir) : undefined });
  }

  detachInstance(instanceId: string): void {
    this.hostProviders.delete(instanceId);
  }

  /** R6：动态解析 HostPort（优先 canonical 实例）。 */
  host(): HostPort {
    for (const p of this.hostProviders.values()) if (p.canonical) return p.mkHost();
    for (const p of this.hostProviders.values()) return p.mkHost();
    const e = new Error('无存活插件实例（HostUnavailable）');
    (e as unknown as { name: string }).name = 'HostUnavailable';
    throw e;
  }

  /** 会话 location 登记（dispatch 创建会话时调用）。 */
  recordSessionLocation(sessionId: string, directory: string): void {
    this.sessionLocation.set(sessionId, normalizeDirKey(directory));
  }

  /** 按会话所在 location 路由 HostPort（ctx.session 域 per-location，实测）；无匹配实例时回退 canonical。 */
  hostForSession(sessionId: string): HostPort {
    const dir = this.sessionLocation.get(sessionId);
    if (dir) {
      for (const p of this.hostProviders.values()) {
        if (p.locationDir === dir) return p.mkHost();
      }
    }
    return this.host();
  }

  /** R5：事件只做唤醒——实例事件订阅转发至此；幂等。 */
  wake(): void {
    for (const cb of this.wakeCallbacks) {
      try { cb(); } catch { /* 唤醒失败不影响正确性（有界轮询兜底） */ }
    }
  }

  onWake(cb: () => void): () => void {
    this.wakeCallbacks.add(cb);
    return () => this.wakeCallbacks.delete(cb);
  }

  isLeader(): boolean {
    return this.lease.role === 'leader';
  }

  // ---------- 初始化 / 停止 ----------

  async init(): Promise<void> {
    const t0 = Date.now();
    // 0. 目标项目 opencode.json 顶层 `dcae` 键 → 配置合并（实测 ctx.options 通道不可用——
    //    2026-11-16 rawOptions:{}；配置先于代码原则：项目 config 是权威载体）
    try {
      const { readProjectDcaeConfig } = await import('../schema/common.ts');
      const projCfg = readProjectDcaeConfig(this.opts.canonical);
      if (projCfg) Object.assign(this.config, projCfg);
    } catch { /* 配置缺失/损坏：用默认 */ }
    // 1. 快照 + 事件重放 → 投影（快照损坏 → 全量重放）
    const snapFile = join(this.dcaeDir, 'state', 'snapshot.json');
    if (existsSync(snapFile)) {
      try {
        const raw = JSON.parse(readFileSync(snapFile, 'utf8'));
        if (this.projection.loadSnapshot(raw)) {
          this.snapEpochFloor = Number(raw?.epoch ?? 0);
          this.snapshotCounter = 200; // 立即续写节奏
        }
      } catch { /* 坏快照：全量重放 */ }
    }
    this.eventLog.load();
    for (const e of this.eventLog.all()) {
      if (e.seq <= this.projection.uptoSeq) continue;
      this.projection.apply(e);
    }
    for (const k of doneKeys(this.dcaeDir)) this.projection.seenKeys.add(k);
    this.rebuildCounters();
    // 2. 租约（新 epoch = max(lock, 日志末条, snapshot)+1）
    this.lease.tryAcquire(Math.max(this.eventLog.lastEpoch(), this.snapEpochFloor));
    // 3. leader 侧启动（Reconciler + 邮箱消费）
    if (this.isLeader()) await this.onLeadershipGained();
    this.ready = true;
    this.log.info('kernel', '内核初始化完成', {
      ms: Date.now() - t0,
      events: this.eventLog.lastSeq(),
      tasks: this.projection.tasks.size,
      role: this.lease.role,
      epoch: this.lease.epoch,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.lease.stop();
    this.scheduler?.stop();
    this.scheduler = null;
    if (this.mailboxTimer) { clearInterval(this.mailboxTimer); this.mailboxTimer = null; }
    this.ready = false;
    this.log.info('kernel', '内核停止（引用计数归零）');
  }

  private async onLeadershipGained(): Promise<void> {
    const { Reconciler } = await import('./reconciler.ts');
    await new Reconciler(this).run();
    if (!this.mailboxTimer) {
      this.mailboxTimer = setInterval(() => void this.consumeMailbox(), 5_000);
      (this.mailboxTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private async onLeadershipLost(): Promise<void> {
    if (this.mailboxTimer) { clearInterval(this.mailboxTimer); this.mailboxTimer = null; }
    this.appendMark('leader-lost', { epoch: this.lease.epoch });
  }

  // ---------- R7：单一写入口 ----------

  async ingest(req: IngestRequest): Promise<IngestResult> {
    if (this.isLeader()) return this.processIngest(req);
    // follower：写邮箱（R8），由持有者心跳（≤5s）消费；同一套检查在持有者端执行
    const key = this.computeKey(req).key;
    enqueue(this.dcaeDir, req.kind, key, { ...req.payload, task: req.task, session: req.session });
    this.log.info('kernel', 'follower 入队', { key, kind: req.kind });
    return { ok: true, queued: 'enqueued', detail: '已排队（≤5s 生效）' };
  }

  private computeKey(req: IngestRequest): { key: string; seq: number; base: string | null } {
    if (req.kind === 'decision') {
      return { key: String(req.payload.inboxId ?? ulid()), seq: 0, base: null };
    }
    const base = `${req.task}:${req.session}:${req.kind}`;
    const seq = this.counters.get(base) ?? 0;
    return { key: `${base}:${seq}`, seq, base };
  }

  private rebuildCounters(): void {
    this.counters.clear();
    for (const e of this.eventLog.all()) {
      const key = (e.data as any)?.key;
      if (typeof key !== 'string') continue;
      const m = /^(.*):(submit|test_submit|question|dcp):(\d+)$/.exec(key);
      if (!m) continue;
      const base = `${m[1]}:${m[2]}`;
      this.counters.set(base, Math.max(this.counters.get(base) ?? 0, Number(m[3]) + 1));
    }
  }

  /** 邮箱消费（leader，每心跳 ≤5s 延迟）。 */
  async consumeMailbox(): Promise<void> {
    if (!this.isLeader()) return;
    const items = consumeAll<Record<string, unknown>>(this.dcaeDir);
    for (const { env } of items) {
      const req: IngestRequest = {
        kind: env.kind,
        task: (env.payload?.task as string) ?? '*',
        session: (env.payload?.session as string) ?? '*',
        payload: { ...env.payload, inboxId: env.idempotencyKey },
      };
      const r = await this.processIngest(req, env.idempotencyKey);
      this.log.info('kernel', '邮箱消费', { key: env.idempotencyKey, ok: r.ok, detail: r.detail });
    }
  }

  /** 核心：幂等键去重 → 状态守卫 → 事件追加 → 效果（架构设计 §3.2 ingest 内部序）。 */
  async processIngest(req: IngestRequest, keyOverride?: string): Promise<IngestResult> {
    if (!this.ready) return { ok: false, detail: '内核未就绪' };
    const { key, seq, base } = this.computeKey(req);
    const key0 = keyOverride ?? key;
    if (this.projection.seenKeys.has(key0)) return { ok: true, queued: 'duplicate', detail: `重复投递（键 ${key0}）` };
    const t = this.projection.task(req.task);

    switch (req.kind) {
      case 'submit': {
        const g = this.guard(t, 'dcae_submit', req);
        if (!g.ok) return { ok: false, detail: g.detail };
        const ev = this.appendTransition(t, 'dcae_submit', { key: key0 });
        if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
        if (base) this.counters.set(base, seq + 1);
        void this.runGatePipeline(req.task, t.attempt); // 异步：结果追加 gate-pass/gate-fail/gate-exhausted
        return { ok: true, queued: 'processed', event: ev };
      }
      case 'test_submit': {
        if (t.state !== 'TEST_WRITING') return { ok: false, detail: `仅在 TEST_WRITING 被接受（当前 ${t.state}）` };
        const { submitBlindTests } = await import('../dispatch/audit.ts');
        return submitBlindTests(this, req, key0);
      }
      case 'question': {
        const g = this.guard(t, 'question');
        if (!g.ok) return { ok: false, detail: g.detail };
        const { createQuestionInbox } = await import('../inbox/inbox.ts');
        const item = createQuestionInbox(this, req.task, String(req.payload.question ?? ''), (req.payload.options as any) ?? undefined);
        if (base) this.counters.set(base, seq + 1);
        const ev = this.appendTransition(t, 'question', { key: key0, inboxId: item?.id });
        if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
        return { ok: true, queued: 'processed', event: ev };
      }
      case 'dcp': {
        const g = this.guard(t, 'dcp-pending');
        if (!g.ok) return { ok: false, detail: g.detail };
        const { writeDcp } = await import('../dcp/dcp.ts');
        const dcp = writeDcp(this, req.task, req.payload);
        if (base) this.counters.set(base, seq + 1);
        const ev = this.appendTransition(t, 'dcp-pending', { key: key0, dcpId: dcp?.id });
        if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
        return { ok: true, queued: 'processed', event: ev };
      }
      case 'decision': {
        const { applyDecision } = await import('../inbox/inbox.ts');
        return applyDecision(this, key0, req.payload);
      }
    }
  }

  /** 构造守卫上下文（纯投影读取；效果层实测值经 append 前覆写）。 */
  guard(t: { state: State; attempt: number; blockedReason: string | null; reviewRounds: number; gateFailSignatures: string[]; id: string }, trigger: Trigger, req?: IngestRequest): { ok: true } | { ok: false; detail: string } {
    const def = this.taskDef(t.id);
    const c: GuardContext = {
      attempt: t.attempt,
      attemptsLeft: Math.max(0, (def?.budget.attempts ?? 3) - t.attempt),
      sessionMatches: req ? this.projection.task(req.task).sessionId === req.session : true,
      signatureNew: !t.gateFailSignatures.includes(String((req?.payload as any)?.signature ?? '')),
      scopeClean: true,
      hasOpenVerifiableHigh: false,
      reviewCycles: def?.budget.review_cycles ?? 1,
      reviewRounds: t.reviewRounds,
      blindTests: def?.blind_tests ?? false,
      testerBudgetAvailable: true,
      planApproved: true,
      invalidationNoIntersection: true,
      depsMerged: (def?.deps ?? []).every((d) => this.projection.task(d).state === 'MERGED'),
      decisionRestoreState: decisionRestore(String((req?.payload as any)?.kind ?? ''), String((req?.payload as any)?.option ?? ''), t.state),
      blockedReason: t.blockedReason,
    };
    const v = transition(t.state, trigger, c, c.decisionRestoreState);
    return v.ok ? { ok: true } : { ok: false, detail: v.detail ?? 'guard 拒绝' };
  }

  taskDef(taskId: string): TaskDef | null {
    return loadTaskDef(join(this.opts.canonical, 'tasks', `${taskId}.yaml`));
  }

  // ---------- 事件追加 ----------

  /** 迁移事件（from=t.state，to 由 targets 映射）；租约丢失返回 null。 */
  appendTransition(t: import('../schema/snapshot.ts').TaskRuntime, reason: Reason, data?: unknown): DcaeEvent | null {
    const target = TARGET_OF[reason];
    const to = target ? target(t, data) : t.state;
    return this.appendDraft({ task: t.id, from: t.state, to, reason, actor: 'kernel', data });
  }

  appendMarkForTask(t: import('../schema/snapshot.ts').TaskRuntime, reason: Reason, data?: unknown): DcaeEvent | null {
    return this.appendDraft({ task: t.id, from: t.state, to: t.state, reason, actor: 'kernel', data });
  }

  appendMark(reason: Reason, data?: unknown): DcaeEvent | null {
    return this.appendDraft({ task: '*', from: 'PENDING', to: 'PENDING', reason, actor: 'kernel', data });
  }

  appendDraft(draft: DraftEvent): DcaeEvent | null {
    const r = this.eventLog.append(draft);
    if (!r.ok) return null;
    this.projection.apply(r.event);
    this.maybeSnapshot();
    return r.event;
  }

  private maybeSnapshot(): void {
    this.snapshotCounter++;
    if (this.snapshotCounter % 200 !== 0) return;
    try {
      this.eventLog.saveSnapshot(this.projection.toSnapshot(this.lease.epoch), join(this.dcaeDir, 'state', 'snapshot.json'));
    } catch { /* 快照失败不阻塞 */ }
  }

  // ---------- 门禁（M3 效果层入口；submit 后异步执行） ----------

  async runGatePipeline(taskId: string, attempt: number): Promise<void> {
    try {
      const { runGatePipeline } = await import('../gates/runner.ts');
      await runGatePipeline(this, taskId, attempt);
    } catch (e) {
      this.log.error('kernel', '门禁执行异常', { taskId, error: String(e) });
      this.appendTransition(this.projection.task(taskId), 'gate-exhausted', { error: String(e) });
    }
  }

  /** 供引擎模块使用。 */
  runtime(taskId: string): import('../schema/snapshot.ts').TaskRuntime {
    return this.projection.task(taskId);
  }

  /** 内核自有会话判定（evaluate 钩子与契约测试用）。 */
  ownsSession(sessionID: string): boolean {
    for (const t of this.projection.tasks.values()) {
      if (t.sessionId === sessionID) return true;
    }
    return false;
  }

  /** unattended-ask-denied 标记（1.4 §6.2）。 */
  recordUnattendedAsk(sessionID: string, action: string, resources: string[]): void {
    const task = this.taskOfSession(sessionID) ?? '*';
    const t = task === '*' ? null : this.projection.tasks.get(task);
    if (t) this.appendMarkForTask(t, 'unattended-ask-denied', { session: sessionID, action, resources });
    else this.appendMark('unattended-ask-denied', { session: sessionID, action, resources });
  }

  taskOfSession(sessionID: string): string | null {
    for (const t of this.projection.tasks.values()) {
      if (t.sessionId === sessionID) return t.id;
    }
    return null;
  }

  statusSnapshot() {
    const tasks: Record<string, number> = {};
    for (const t of this.projection.tasks.values()) tasks[t.state] = (tasks[t.state] ?? 0) + 1;
    const hb = this.lease.readLock()?.heartbeat_at ?? new Date().toISOString();
    return {
      mode: this.isLeader() ? ('leader' as const) : ('follower' as const),
      epoch: this.lease.epoch,
      lease_age_s: Math.max(0, Math.round((Date.now() - Date.parse(hb)) / 1000)),
      tasks,
    };
  }

  taskIds(): string[] {
    return [...this.projection.tasks.keys()];
  }

  /** 项目级权限规则（策略编译的项目基线；jsonc 尽力解析）。 */
  projectRules(): Rule[] {
    for (const name of ['opencode.json', 'opencode.jsonc'] as const) {
      const p = join(this.opts.canonical, name);
      if (!existsSync(p)) continue;
      try {
        const cfg = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(cfg?.permissions)) return cfg.permissions;
      } catch {
        // jsonc：粗剥注释后重试
        try {
          const text = readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const cfg = JSON.parse(text);
          if (Array.isArray(cfg?.permissions)) return cfg.permissions;
        } catch { /* 尽力 */ }
      }
    }
    return [];
  }

  /** inbox 序号分配（扫描目录）。 */
  nextInboxNumber(): number {
    const dir = join(this.dcaeDir, 'inbox');
    if (!existsSync(dir)) return 1;
    let max = 0;
    for (const f of readdirSync(dir)) {
      const m = /^INBOX-(\d+)\.yaml$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  /** 目录是否存在（引擎辅助）。 */
  exists(p: string): boolean {
    try { return statSync(p).isFile() || statSync(p).isDirectory(); } catch { return false; }
  }
}
