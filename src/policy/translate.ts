/**
 * DCAE glob → 平台 resource 翻译（架构设计 §8.2 翻译表）。
 * 平台语义：`*` → `.*`（跨 `/`）、`?` → 单字符、首尾锚定、无独立 `**`（1.4 §6.2 [D][S]）。
 * 可精确编译：保护路径 deny、项目外 deny、递归写范围 allow 近似（`src/**` → `src/*`）。
 * 不可精确编译：单段写范围——调用方检测 isSingleSegment 后不编译为 allow。
 */
import type { KernelConfig } from '../schema/common.ts';

/** 单段模式判定：含 `*` 但无 `**` 且模式意图为"单段"（无斜杠跨段语义）。 */
export function isSingleSegment(pattern: string): boolean {
  const p = pattern.replace(/\/+$/, '');
  if (p.includes('**')) return false;
  // `src/*.ts`（单段意图）vs `specs/*`（仅一层，deny 场景允许过宽——只有 allow 场景需要判定）
  return !p.endsWith('/**') && p.includes('*');
}

/**
 * 翻译为平台 resource 字符串。返回 null = 不可翻译（调用方记 untranslatable）。
 * compilerMode：'star-crosses-slash'（现状）| 'globstar'（未来 PR #28689 复活时；
 * 该模式下降级为 fail-closed——递归范围译作原样 `src/**`（平台将理解 globstar），
 * 语义翻转方向由契约测试 T-8 在每次升级时重测（1.4 §6.2"语义是移动目标"）。
 */
export function dcaeGlobToPlatform(pattern: string, cfg?: Partial<KernelConfig>): string | null {
  const mode = cfg?.compilerMode ?? 'star-crosses-slash';
  let p = pattern.replace(/\/+$/, '');
  if (p === '' ) return null;
  if (p === '.' || p === '/') return '*';

  if (mode === 'globstar') {
    // 未来语义：`*` 不跨 `/`、`**` 跨。DCAE 语义与之同构——除 `X/**` 含 X 自身需拆两条。
    return p; // 原样（X/** 的自身含入由调用方叠加 `X` 一条；当前实现保守返回原样）
  }

  // star-crosses-slash（现状语义）：
  if (p.endsWith('/**')) {
    // 递归：`X/**` → `X/*`（少覆盖 X 自身——目录自身的改动出现在事后 diff 中，1.4 §6.2 逐字）
    return `${p.slice(0, -3)}/*`;
  }
  if (p === '**') return '*';
  // 单层 `X/*`：平台 `*` 跨 `/` 会过授权——deny 场景恰好无损（更宽的 deny 仍精确命中意图面），
  // allow 场景由调用方以 isSingleSegment 拦截。此处按字面保留。
  return p;
}
