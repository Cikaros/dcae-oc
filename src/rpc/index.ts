/**
 * RPC 契约导出（官方 "Publish"：Export ./rpc when other plugins and clients should
 * import your RPC contract without loading your implementation——build-plugins-index 逐字）。
 * 供 dcae CLI 与外部客户端 `client.rpc()` 使用；实现见 status.ts / contract.ts。
 */

/** `dcae/status`（1.4 §5.3 RPC 最小契约）。 */
export const DcaeRpc = {
  id: 'dcae',
  methods: {
    status: {
      output: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['leader', 'follower'] },
          epoch: { type: 'number' },
          lease_age_s: { type: 'number' },
          tasks: { type: 'object', additionalProperties: { type: 'number' } },
        },
        required: ['mode', 'epoch', 'lease_age_s', 'tasks'],
      },
    },
  },
  events: {},
} as const;

export type StatusOutput = {
  mode: 'leader' | 'follower';
  epoch: number;
  lease_age_s: number;
  tasks: Record<string, number>;
};

/** `dcae/contract`（仅 DCAE_CONTRACT=1 的服务器注册；M0 契约探针）。 */
export const ContractRpc = {
  id: 'dcae',
  methods: {
    status: { output: { type: 'object', additionalProperties: true } },
    contract: { input: { type: 'object' }, output: { type: 'object', additionalProperties: true } },
  },
  events: {},
} as const;
