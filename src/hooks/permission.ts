/**
 * evaluate 钩子 —— 无人值守 ask 自动处置（1.4 §6.2；架构设计 §3.16）。
 * 内核自有会话的 ask 决策一律改判 deny 并记事件（reason: unattended-ask-denied）——
 * ask 无人应答即 pending，pending 在 reload 时被取消 [A]；fail-closed 优于无限阻塞。
 * allow 直通；配置 deny 平台不进钩子（[D]，最终）。
 * 钩子精确签名属 [I]（M0 T-6）：按文档语义实现；resources 为 ReadonlyArray（不可改写），
 * message 可改写——实测不符时回退面 = 编译期 deny-all 已是主防线。
 */
import type { Plugin } from '@opencode/plugin';
import type { Kernel } from '../kernel/kernel.ts';

export function registerPermissionHook(ctx: Plugin.Context, kernel: Kernel): void {
  ctx.permission.hook('evaluate', (input: { sessionID: string; action: string; resources: readonly string[]; effect: 'allow' | 'deny' | 'ask'; message?: string }) => {
    if (!kernel.ownsSession(input.sessionID)) return; // 非内核会话：不干预
    if (input.effect === 'ask') {
      input.effect = 'deny';
      input.message = 'DCAE 无人值守会话：ask 决策自动改判 deny（unattended-ask-denied）。';
      kernel.recordUnattendedAsk(input.sessionID, input.action, [...input.resources]);
    }
    // allow 直通（编译 allow 与 saved approval 区分不可靠，越界 allow 由事后 diff 权威兜底）
  });
}
