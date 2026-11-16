/**
 * DCP —— 设计变更提案（1.4 §6.9）。
 * 内核把 DCP 写入 canonical 检出的 dcp/DCP-<n>.yaml；任务 worktree 中的任何东西不能修改它们。
 * 待决阻塞来源任务（→BLOCKED dcp-pending）；决策经 inbox 通道。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../util/atomic-write.ts';
import { stringify as stringifyYaml } from 'yaml';
import type { Kernel } from '../kernel/kernel.ts';

export interface DcpFile {
  schema_version: 1;
  id: string;
  task: string;
  observation: string;
  evidence_refs: string[];
  proposal: string;
  affected_specs: string[];
  risk: 'low' | 'medium' | 'high';
  status: 'open' | 'decided';
  created_at: string;
  decision?: { option: string; note?: string; decided_at: string };
}

export function writeDcp(kernel: Kernel, task: string, payload: Record<string, unknown>): DcpFile | null {
  const dir = join(kernel.opts.canonical, 'dcp');
  const n = nextDcpNumber(dir);
  const dcp: DcpFile = {
    schema_version: 1,
    id: `DCP-${String(n).padStart(3, '0')}`,
    task,
    observation: String(payload.observation ?? ''),
    evidence_refs: (payload.evidence_refs as string[]) ?? [],
    proposal: String(payload.proposal ?? ''),
    affected_specs: (payload.affected_specs as string[]) ?? [],
    risk: (['low', 'medium', 'high'] as const).includes(payload.risk as never) ? (payload.risk as DcpFile['risk']) : 'medium',
    status: 'open',
    created_at: new Date().toISOString(),
  };
  atomicWrite(join(dir, `${dcp.id}.yaml`), stringifyYaml(dcp));
  // 待决 DCP 创建 inbox 决策项（1.4 §6.9：决策经 §6.8 通道）
  void import('../inbox/inbox.ts').then(({ createInboxItem }) => {
    createInboxItem(kernel, {
      kind: 'dcp',
      task,
      dcp: dcp.id,
      question: `DCP ${dcp.id}（风险 ${dcp.risk}）：${dcp.proposal}`,
      options: [
        { id: 'accept', label: '接受提案（进入 spec 审批流）' },
        { id: 'reject', label: '拒绝提案（任务继续原方案）' },
      ],
    });
  });
  return dcp;
}

function nextDcpNumber(dir: string): number {
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const f of readdirSync(dir)) {
    const m = /^DCP-(\d+)\.yaml$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
