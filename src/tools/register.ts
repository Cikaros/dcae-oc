/**
 * 六工具注册（1.4 §5.3：恰好六个，codemode false，各断言 `dcae.<tool>` 权限）。
 * 改状态工具全部走 Kernel.ingest()（R7）；只读工具直查投影。
 * 回退面（1.4 §2 #2）：若 `dcae.<tool>` action 粒度实测不可行（M0 T-5），提示层退化为全插件
 * 一个权限面——工具处理器内部的状态守卫是权威防线，正确性不受损。
 */
import type { Plugin } from '@opencode/plugin';
import type { Kernel } from '../kernel/kernel.ts';
import { resolvePull } from '../context/resolver.ts';

type Ctx = Plugin.Context;

/** 平台边界的宽松工具形态（SDK 泛型为 Effect Schema；注册处以 as never 收口）。 */
interface ToolInfoLite {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: any, tctx: { sessionID: string }) => Promise<{ content: string }>;
  options: { permission: string; codemode: false };
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });

export function registerTools(ctx: Ctx, kernel: Kernel): void {
  const tools: ToolInfoLite[] = [
    {
      name: 'dcae_submit',
      description: 'dev 提交任务完成（RUNNING 且 attempt 匹配才被接受）。触发门禁验证。',
      input: obj({ summary: str('完成摘要'), notes: str('补充说明（可选）') }, ['summary']),
      execute: async (input, tctx) => {
        const r = await kernel.ingest({ kind: 'submit', task: taskOf(tctx.sessionID, kernel), session: tctx.sessionID, payload: { ...input } });
        return { content: describe(r) };
      },
      options: { permission: 'dcae.dcae_submit', codemode: false },
    },
    {
      name: 'dcae_test_submit',
      description: 'tester 提交盲测验收测试（仅 TEST_WRITING）。路径必须全部位于 acceptance/<task>/ 之下；提交前执行读越界审计。',
      input: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'acceptance/<task>/ 下的测试文件路径' } }, ['paths']),
      execute: async (input, tctx) => {
        const r = await kernel.ingest({ kind: 'test_submit', task: taskOf(tctx.sessionID, kernel), session: tctx.sessionID, payload: { paths: (input as any).paths } });
        return { content: describe(r) };
      },
      options: { permission: 'dcae.dcae_test_submit', codemode: false },
    },
    {
      name: 'dcae_question',
      description: '向人类提问（任务进入 BLOCKED，创建收件箱项）。',
      input: obj({ question: str('问题'), options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false }, description: '候选选项（可选）' } }, ['question']),
      execute: async (input, tctx) => {
        const r = await kernel.ingest({ kind: 'question', task: taskOf(tctx.sessionID, kernel), session: tctx.sessionID, payload: { ...(input as any) } });
        return { content: describe(r) };
      },
      options: { permission: 'dcae.dcae_question', codemode: false },
    },
    {
      name: 'dcae_dcp',
      description: '提交设计变更提案（DCP 草稿；来源任务进入 BLOCKED 待决策）。',
      input: obj({
        observation: str('观察到的设计问题'),
        evidence_refs: { type: 'array', items: { type: 'string' }, description: '证据引用（事件/证据 ID）' },
        proposal: str('变更提案'),
        affected_specs: { type: 'array', items: { type: 'string' }, description: '受影响规范 ID' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: '风险级别' },
      }, ['observation', 'proposal']),
      execute: async (input, tctx) => {
        const r = await kernel.ingest({ kind: 'dcp', task: taskOf(tctx.sessionID, kernel), session: tctx.sessionID, payload: input as Record<string, unknown> });
        return { content: describe(r) };
      },
      options: { permission: 'dcae.dcae_dcp', codemode: false },
    },
    {
      name: 'dcae_context_pull',
      description: '拉取预算内的上下文包（规范、checks、任务事件）。',
      input: obj({ want: str('想要的内容（spec/check/证据/全部）') }, ['want']),
      execute: async (input, tctx) => {
        const taskId = taskOf(tctx.sessionID, kernel);
        const def = kernel.taskDef(taskId);
        if (!def) return { content: `任务定义不可用：${taskId}` };
        return { content: resolvePull(kernel, def, (input as any).want) };
      },
      options: { permission: 'dcae.dcae_context_pull', codemode: false },
    },
    {
      name: 'dcae_status',
      description: '只读查询任务、预算、证据状态。',
      input: obj({ task: str('任务 ID（缺省 = 当前会话任务）') }, []),
      execute: async (input, tctx) => {
        const taskId = (input as any).task ?? taskOf(tctx.sessionID, kernel);
        const t = kernel.projection.tasks.get(taskId);
        if (!t) return { content: `任务未知：${taskId}` };
        const def = kernel.taskDef(taskId);
        return {
          content: [
            `任务 ${taskId}：${t.state}${t.blockedReason ? `（${t.blockedReason}）` : ''}`,
            `attempt ${t.attempt}/${def?.budget.attempts ?? '?'}，reviewRounds ${t.reviewRounds}/${def?.budget.review_cycles ?? 0}`,
            `无提交空闲提醒 ${t.idleNudges}，等待延续 ${t.waitContinuations}`,
            `失败签名 ${t.gateFailSignatures.length} 个`,
            def ? `预算：tokens ${def.budget.tokens} / minutes ${def.budget.minutes}` : '',
          ].filter(Boolean).join('\n'),
        };
      },
      options: { permission: 'dcae.dcae_status', codemode: false },
    },
  ];

  ctx.tool.transform((editor) => { const ed = editor as unknown as { add: (t: unknown) => void };
    for (const t of tools) ed.add(t as never);
  });
}

/** 会话所属任务（dispatch 盖章 → 投影反查；无则空串）。 */
function taskOf(sessionID: string, kernel: Kernel): string {
  for (const t of kernel.projection.tasks.values()) {
    if (t.sessionId === sessionID) return t.id;
  }
  return '';
}

function describe(r: { ok: boolean; queued?: string; detail?: string }): string {
  if (!r.ok) return `拒绝：${r.detail ?? '未知原因'}`;
  if (r.queued === 'enqueued') return r.detail ?? '已排队';
  if (r.queued === 'duplicate') return r.detail ?? '重复投递（返回首次结果语义）';
  return '已接受';
}
