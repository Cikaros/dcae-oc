/**
 * EventLog —— 事件溯源状态存储（1.4 §6.5；架构设计 §3.3）。
 * append 三重守卫：(a) seq 连续 (b) epoch=自身租约 epoch (c) 即时重读 lock 确认持有者。
 * 任一失败：放弃写入、降级 follower、触发 Reconciler。
 */
import { appendJsonl, readJsonl } from '../util/jsonl.ts';
import { atomicWrite } from '../util/atomic-write.ts';
import { EventSchema, type DcaeEvent, type DraftEvent } from '../schema/event.ts';

export interface LockSnapshot {
  epoch: number;
  holderKernelId: string;
}

export interface AppendGuardDeps {
  /** 即时重读 lock.json（守卫 c）。 */
  readLock(): LockSnapshot | null;
  /** 自身租约身份（可变引用；epoch 随租约更新）。 */
  self: { epoch: number; kernelId: string };
  /** 守卫失败回调：降级 follower + Reconciler。 */
  onGuardFailure(reason: string): void;
}

export class EventLog {
  private events: DcaeEvent[] = [];

  constructor(
    readonly file: string,
    private deps: AppendGuardDeps,
  ) {}

  /** 从磁盘装载（重启重建；尾部半行由 readJsonl 跳过）。 */
  load(): void {
    const raw = readJsonl<DcaeEvent>(this.file);
    this.events = [];
    for (const e of raw) {
      const r = EventSchema.safeParse(e);
      if (r.success) this.events.push(r.data);
    }
  }

  /** 内存重放流（投影重建用）。 */
  all(): readonly DcaeEvent[] {
    return this.events;
  }

  lastSeq(): number {
    return this.events.length > 0 ? this.events[this.events.length - 1]!.seq : 0;
  }

  lastEpoch(): number {
    let e = 0;
    for (const ev of this.events) e = Math.max(e, ev.epoch);
    return e;
  }

  /** 末条 seq 之后的 epoch 倒挂审计（Reconciler；1.4 §6.5 残余窗口补偿）。 */
  findEpochInversion(): { at: number; event: DcaeEvent } | null {
    let maxEpoch = 0;
    for (const ev of this.events) {
      if (ev.epoch < maxEpoch) return { at: ev.seq, event: ev };
      maxEpoch = Math.max(maxEpoch, ev.epoch);
    }
    return null;
  }

  /**
   * 三重守卫内联追加。成功返回已提交事件；失败返回 null（调用方不得继续使用投影推进状态）。
   */
  append(draft: DraftEvent): { ok: true; event: DcaeEvent } | { ok: false; reason: string } {
    const self = this.deps.self;
    // 守卫 b：无租约 / epoch 不符 → 拒绝（只有 leader 能追加）
    const lock = this.deps.readLock();
    if (!lock) return { ok: false, reason: 'no-lease' };
    if (lock.epoch !== self.epoch || lock.holderKernelId !== self.kernelId) {
      this.deps.onGuardFailure(`lock-holder-mismatch: lock=${lock.holderKernelId}@${lock.epoch} self=${self.kernelId}@${self.epoch}`);
      return { ok: false, reason: 'lease-lost' };
    }
    // 守卫 a：seq 连续
    const seq = this.lastSeq() + 1;
    const event: DcaeEvent = {
      seq,
      epoch: self.epoch,
      ts: new Date().toISOString(),
      ...draft,
    };
    // 落盘（守卫 c 已在 readLock 即时重读中完成；写入与 (c) 之间的毫秒级 TOCTOU 为 1.4 §6.5 声明的残余窗口，
    // 由 Reconciler 的 epoch 倒挂审计 + quarantine 补偿）
    try {
      appendJsonl(this.file, event);
    } catch (e) {
      this.deps.onGuardFailure(`append-failed: ${String(e)}`);
      return { ok: false, reason: 'append-failed' };
    }
    this.events.push(event);
    return { ok: true, event };
  }

  /** 快照写盘（周期；加速重启）。 */
  saveSnapshot(snap: unknown, file: string): void {
    atomicWrite(file, JSON.stringify(snap));
  }
}
