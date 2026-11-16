/**
 * Lease —— 租约即围栏（R4；1.4 §6.5）。
 * .dcae/lock.json = { schema_version, epoch, holder{kernelId,pid}, heartbeat_at }。
 * 心跳 5s；20s 判陈旧；获取 = temp+rename 原子替换；新 epoch = max(lock, 日志末条, snapshot)+1。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write.ts';
import { ulid } from '../util/ulid.ts';

export interface LockFile {
  schema_version: 1;
  epoch: number;
  holder: { kernelId: string; pid: number };
  heartbeat_at: string;
}

export const HEARTBEAT_MS = 5_000;
export const STALE_MS = 20_000;

export type LeaseRole = 'leader' | 'follower';

export class Lease {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** 低频周期回调（saved approvals 复核，决议 D-1：每 auditEveryTicks 个心跳一次）。 */
  onPeriodicAudit: (() => void) | null = null;

  constructor(
    readonly dcaeDir: string,
    readonly kernelId: string,
    private onRoleChange: (role: LeaseRole, epoch: number) => void,
  ) {}

  private get lockFile(): string {
    return join(this.dcaeDir, 'lock.json');
  }

  role: LeaseRole = 'follower';
  epoch = 0;

  readLock(): LockFile | null {
    try {
      if (!existsSync(this.lockFile)) return null;
      const raw = JSON.parse(readFileSync(this.lockFile, 'utf8')) as LockFile;
      if (typeof raw?.epoch !== 'number' || !raw?.holder) return null;
      return raw;
    } catch {
      return null;
    }
  }

  isStale(lock: LockFile): boolean {
    return Date.now() - Date.parse(lock.heartbeat_at) > STALE_MS;
  }

  mine(lock: LockFile): boolean {
    return lock.holder.kernelId === this.kernelId;
  }

  /** 尝试获取/接管租约（缺失或陈旧时成功）。floorEpoch：日志末条/snapshot 的 epoch 下限。 */
  tryAcquire(floorEpoch: number): boolean {
    const lock = this.readLock();
    if (lock && !this.isStale(lock) && !this.mine(lock)) return false;
    const nextEpoch = Math.max(lock?.epoch ?? 0, floorEpoch, this.epoch) + 1;
    const fresh: LockFile = {
      schema_version: 1,
      epoch: nextEpoch,
      holder: { kernelId: this.kernelId, pid: process.pid },
      heartbeat_at: new Date().toISOString(),
    };
    atomicWrite(this.lockFile, JSON.stringify(fresh, null, 2));
    const changed = this.role !== 'leader';
    this.role = 'leader';
    this.epoch = nextEpoch;
    if (changed) this.onRoleChange('leader', nextEpoch);
    this.startHeartbeat();
    return true;
  }

  /** 心跳（5s）：重写 lock；发现 holder≠self → 立即降级 follower。 */
  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickCount++;
      const lock = this.readLock();
      if (!lock || !this.mine(lock)) {
        this.demote('lock-missing-or-taken');
        return;
      }
      if (this.isStale(lock)) {
        // 自身心跳迟滞超时（挂起后恢复）：重写心跳并保持
        this.tryAcquire(this.epoch);
        return;
      }
      const fresh: LockFile = { ...lock, heartbeat_at: new Date().toISOString() };
      try {
        atomicWrite(this.lockFile, JSON.stringify(fresh));
      } catch {
        this.demote('heartbeat-write-failed');
        return;
      }
      if (this.onPeriodicAudit && this.tickCount % Math.max(1, Math.round(30_000 / HEARTBEAT_MS)) === 0) {
        this.onPeriodicAudit();
      }
    }, HEARTBEAT_MS);
    // Bun/Node：不阻塞退出
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  demote(reason: string): void {
    const was = this.role;
    this.role = 'follower';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (was === 'leader') this.onRoleChange('follower', this.epoch);
    void reason;
  }

  /** 写前验证（非幂等宿主动作前重读确认；缩小脑裂窗口）。 */
  verify(): boolean {
    const lock = this.readLock();
    return !!lock && this.mine(lock) && lock.epoch === this.epoch;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.role === 'leader') {
      this.role = 'follower';
      // 主动让位：写一个即时过期的心跳，让 follower 20s 内可接管
      const lock = this.readLock();
      if (lock && this.mine(lock)) {
        try {
          atomicWrite(this.lockFile, JSON.stringify({ ...lock, heartbeat_at: new Date(Date.now() - STALE_MS - 1_000).toISOString() }));
        } catch { /* 尽力 */ }
      }
    }
  }
}

/** 内核身份（进程内创建时生成一次）。 */
export function newKernelId(): string {
  return 'k_' + ulid();
}
