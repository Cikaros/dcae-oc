/**
 * KernelRegistry —— 进程级单例（R2/R3，1.4 §5.2）。
 * 以 ctx.location.project.canonical 为键存于 globalThis[Symbol.for('dcae.kernels')]，
 * 每 location 的模块重求值不可能造出第二个内核。
 */
import type { Kernel } from './kernel.ts';

export interface LocationInfo {
  directory: string;
  projectID: string;
  canonical: string;
}

interface KernelRef {
  kernel: Kernel;
  count: number;
}

const KEY = Symbol.for('dcae.kernels');

interface GlobalWithRegistry {
  [KEY]?: Map<string, KernelRef>;
}

const g = globalThis as typeof globalThis & GlobalWithRegistry;

function registry(): Map<string, KernelRef> {
  if (!g[KEY]) g[KEY] = new Map<string, KernelRef>();
  return g[KEY]!;
}

export interface KernelHandle {
  kernel: Kernel;
  /** 实例 dispose 时调用（R3 引用计数；最后一个实例 release 才停内核）。 */
  release(): void;
}

export function acquireKernel(loc: LocationInfo, create: () => Kernel): KernelHandle {
  const key = loc.canonical;
  let ref = registry().get(key);
  if (!ref) {
    ref = { kernel: create(), count: 0 };
    registry().set(key, ref);
  }
  ref.count++;
  const r = ref;
  return {
    kernel: r.kernel,
    release() {
      r.count--;
      if (r.count <= 0) {
        // count==0：停止心跳/定时器/调度（R3）；Kernel 对象留 Map（冷态可重启）
        void r.kernel.stop();
      }
    },
  };
}

/** 当前进程的内核数（遥测/契约测试用）。 */
export function kernelCount(): number {
  return registry().size;
}

/** 取指定 canonical 的内核（无则 undefined）。 */
export function peekKernel(canonical: string): Kernel | undefined {
  return registry().get(canonical)?.kernel;
}

/** 取任一存活内核（R6：HostPort 动态解析优先 canonical 实例）。 */
export function anyKernel(): Kernel | undefined {
  for (const ref of registry().values()) if (ref.count > 0) return ref.kernel;
  return undefined;
}
