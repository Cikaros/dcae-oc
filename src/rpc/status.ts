/**
 * RPC 最小契约（1.4 §5.3）：只注册一个只读方法 dcae/status，供 dcae CLI 经 client.rpc() 探测。
 * 决策与提交不经 RPC：文件邮箱已是权威且重启安全。
 * 输出用 JSON Schema（2026-11-16 实测：zod 作为 output schema 无法被服务器响应编码——500
 * "Server failed to encode its response"，连 z.any 亦然；Tool.input 的 JSON Schema 形态可用）。
 */
import type { Plugin } from '@opencode/plugin';
import type { Kernel } from '../kernel/kernel.ts';

const statusOutputSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['leader', 'follower'] },
    epoch: { type: 'number' },
    lease_age_s: { type: 'number' },
    tasks: { type: 'object', additionalProperties: { type: 'number' } },
  },
  required: ['mode', 'epoch', 'lease_age_s', 'tasks'],
} as const;

export const DcaeRpc = {
  id: 'dcae',
  methods: {
    status: { output: statusOutputSchema },
  },
  events: {},
} as const;

export function registerRpc(ctx: Plugin.Context, kernel: Kernel): void {
  void ctx.rpc.register(DcaeRpc as never, {
    status: async () => kernel.statusSnapshot(),
  } as never);
}
