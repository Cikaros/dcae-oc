/**
 * /dcae:* 斜杠命令（官方 command transform：editor.add({name, description, execute})）。
 * 查询类：结果经 ctx.session.synthetic 注入会话（不排队 LLM 回合）；
 * 决策类：写 decision 邮箱（与 CLI 同一权威通道，≤5s 生效）。
 */
import type { Plugin } from '@opencode/plugin';
import type { Kernel } from '../kernel/kernel.ts';
import { listInbox } from '../inbox/inbox.ts';
import { enqueue } from '../kernel/mailbox.ts';
import { ulid } from '../util/ulid.ts';

type Ctx = Plugin.Context;

/** 会话内注入一条文本（不排队 LLM 回合）。 */
function makeSynthetic(ctx: Ctx): (sessionID: string, text: string) => Promise<void> {
  return async (sessionID, text) => {
    await (ctx.session as unknown as {
      synthetic: (i: { sessionID: string; id: string; text: string; description: string }) => Promise<unknown>;
    }).synthetic({ sessionID, id: 'msg_' + ulid(), text, description: 'dcae' });
  };
}

/**
 * 仅注册 /dcae-init（无需内核实例）。
 * 用于**非 DCAE 项目**：全局安装的插件在每个 location 加载，此处只提供显式初始化入口，
 * 不注册其余命令、不建内核、不抛错。
 */
export function registerInitCommand(ctx: Ctx): void {
  const synthetic = makeSynthetic(ctx);
  ctx.command.transform((editor) => {
    const ed = editor as unknown as { add: (d: unknown) => void };
    ed.add({
      name: 'dcae-init',
      description: '在当前项目初始化 DCAE-OC（写入 .opencode/agents 等脚手架）',
      execute: async ({ sessionID }: { sessionID: string }) => {
        try {
          const { initProject } = await import('../init/init.ts');
          const r = initProject(ctx.location.project.canonical, { model: undefined });
          await synthetic(
            sessionID,
            [
              `DCAE-OC 初始化完成（${ctx.location.project.canonical}）`,
              `已写入：${r.written.join(', ') || '（无）'}`,
              r.skipped.length > 0 ? `已跳过（已存在）：${r.skipped.join(', ')}` : '',
              '',
              '请提交这些脚手架文件，然后重新加载插件以激活内核。',
            ].filter(Boolean).join('\n'),
          );
        } catch (e) {
          await synthetic(sessionID, `DCAE-OC 初始化失败：${String(e)}`);
        }
      },
    });
  });
}

export function registerCommands(ctx: Ctx, kernel: Kernel): void {
  const synthetic = makeSynthetic(ctx);

  const decide = async (kind: string, id: string, payload: Record<string, unknown>, sessionID: string, ack: string): Promise<void> => {
    enqueue(kernel.dcaeDir, 'decision', id, { ...payload, sessionID });
    await synthetic(sessionID, `${ack}（已入决策邮箱，≤5s 生效）`);
  };

  const cmds = [
    {
      name: 'dcae-init',
      description: '在当前项目初始化 DCAE-OC（写入 .opencode/agents 等脚手架）',
      execute: async ({ sessionID }: { sessionID: string }) => {
        try {
          const { initProject } = await import('../init/init.ts');
          const r = initProject(ctx.location.project.canonical, { model: undefined });
          await synthetic(
            sessionID,
            [
              `DCAE-OC 初始化完成（${ctx.location.project.canonical}）`,
              `已写入：${r.written.join(', ') || '（无）'}`,
              r.skipped.length > 0 ? `已跳过（已存在）：${r.skipped.join(', ')}` : '',
              '',
              '请提交这些脚手架文件，然后重新加载插件以激活内核。',
            ].filter(Boolean).join('\n'),
          );
        } catch (e) {
          await synthetic(sessionID, `DCAE-OC 初始化失败：${String(e)}`);
        }
      },
    },
    {
      name: 'dcae-status',
      description: 'DCAE 内核概览：模式/租约/各状态任务计数与任务明细',
      execute: async ({ sessionID }: { sessionID: string }) => {
        const s = kernel.statusSnapshot();
        const lines = [
          `DCAE ${s.mode}（epoch ${s.epoch}，租约年龄 ${s.lease_age_s}s）`,
          ...Object.entries(s.tasks).map(([st, n]) => `  ${st}: ${n}`),
        ];
        for (const t of kernel.projection.tasks.values()) {
          const def = kernel.taskDef(t.id);
          lines.push(`• ${t.id} ${t.state}${t.blockedReason ? `（${t.blockedReason}）` : ''} attempt ${t.attempt}/${def?.budget.attempts ?? '?'} reviewRounds ${t.reviewRounds}`);
        }
        if (kernel.projection.tasks.size === 0) lines.push('（无任务——先在 tasks/ 定义任务并 dcae plan-approve）');
        await synthetic(sessionID, lines.join('\n'));
      },
    },
    {
      name: 'dcae-inbox',
      description: 'DCAE 收件箱：open 决策项清单',
      execute: async ({ sessionID }: { sessionID: string }) => {
        const items = listInbox(kernel);
        const open = items.filter((i) => i.status === 'open');
        const lines = open.length === 0
          ? ['收件箱为空（无 open 项）']
          : open.map((i) => `${i.id} [${i.kind}]${i.ref.task ? ` ${i.ref.task}` : ''}\n  ${i.question}\n  选项: ${i.options.map((o) => o.id).join(' / ')}`);
        await synthetic(sessionID, lines.join('\n'));
      },
    },
    {
      name: 'dcae-decide',
      description: '决策收件箱项：/dcae-decide INBOX-000001 <option> [备注]',
      execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
        const parts = String(prompt.text ?? '').trim().split(/\s+/).filter(Boolean);
        const [inboxId, option, ...note] = parts;
        if (!inboxId || !option) {
          await synthetic(sessionID, '用法：/dcae-decide INBOX-000001 <option> [备注]');
          return;
        }
        await decide('inbox', inboxId, { option, note: note.join(' '), by: 'session-command' }, sessionID, `/dcae-decide ${inboxId} ${option}`);
      },
    },
    {
      name: 'dcae-plan-approve',
      description: '批准计划：/dcae-plan-approve <TASK-ID> [<TASK-ID>...]',
      execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
        const tasks = String(prompt.text ?? '').trim().split(/\s+/).filter((a) => a && !a.startsWith('/'));
        if (tasks.length === 0) {
          await synthetic(sessionID, '用法：/dcae-plan-approve T-DEMO-001 [T-...]');
          return;
        }
        await decide('plan', `plan-approve:${tasks.join('+')}:${Date.now()}`, { action: 'plan-approve', tasks, by: 'session-command' }, sessionID, `已批准：${tasks.join(', ')}`);
      },
    },
    {
      name: 'dcae-approve-spec',
      description: '批准规范：/dcae-approve-spec SPEC-XXX',
      execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text?: string } }) => {
        const spec = String(prompt.text ?? '').trim().split(/\s+/)[0];
        if (!spec) {
          await synthetic(sessionID, '用法：/dcae-approve-spec SPEC-XXX');
          return;
        }
        await decide('spec', `approve-spec:${spec}:${Date.now()}`, { action: 'approve-spec', spec, by: 'session-command' }, sessionID, `规范已送批：${spec}`);
      },
    },
  ];

  ctx.command.transform((editor) => {
    const ed = editor as unknown as { add: (d: unknown) => void };
    for (const c of cmds) ed.add(c);
  });
}
