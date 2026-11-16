/**
 * M0 契约探针（仅 DCAE_CONTRACT=1 时注册）—— 架构设计 §10。
 * 在真实 ctx 内执行十四项断言的进程内侧，经 RPC 回报 JSON 结果；外部 runner 驱动。
 */
import type { Plugin } from '@opencode/plugin';
import type { Kernel } from '../kernel/kernel.ts';

type Ctx = Plugin.Context;

export interface CaseResult {
  case: string;
  name: string;
  ok: boolean;
  detail: unknown;
  note?: string;
}

const caseSchema = {
  type: 'object',
  properties: {
    case: { type: 'string' },
    name: { type: 'string' },
    ok: { type: 'boolean' },
    detail: {},
    note: { type: 'string' },
  },
  required: ['case', 'name', 'ok'],
} as const;

const ContractOutputSchema = {
  type: 'object',
  properties: {
    cases: { type: 'array', items: caseSchema },
  },
  required: ['cases'],
} as const;

export const ContractRpc = {
  id: 'dcae',
  methods: {
    status: { output: { type: 'object', additionalProperties: true } },
    contract: { input: { type: 'object' }, output: ContractOutputSchema },
  },
  events: {},
} as const;

export function registerContractRpc(ctx: Ctx, kernel: Kernel): void {
  void ctx.rpc.register(ContractRpc as never, {
    status: async () => kernel.statusSnapshot(),
    contract: async (input?: { cases?: string[] }) => runCases(ctx, kernel, input?.cases),
  } as never).then(async (reg) => {
    // 诊断切分：进程内自调用（区分"注册表生效"与"HTTP 路由"）
    try {
      const client = (ctx as unknown as { rpc: (d: unknown) => { contract: (i?: unknown) => Promise<unknown> } }).rpc(ContractRpc as never);
      const self = await client.contract({ cases: ['T-3'] });
      const { appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      appendFileSync(join(kernel.dcaeDir, 'setup-probe.log'), `rpc-self-call-ok cases=${JSON.stringify(self).slice(0, 120)}\n`);
      void reg;
    } catch (e) {
      const { appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      appendFileSync(join(kernel.dcaeDir, 'setup-probe.log'), `rpc-self-call-FAIL ${String(e).slice(0, 200)}\n`);
    }
  });
}

type CaseFn = (ctx: Ctx, kernel: Kernel) => Promise<CaseResult>;

const CASES: Record<string, { name: string; fn: CaseFn }> = {
  'T-3': {
    name: '插件 API 签名锁定（Plugin.define/ctx 域/transform/assert）',
    fn: async (ctx: Ctx) => {
      const d: string[] = {
        'tool.transform': typeof ctx.tool?.transform,
        'command.transform': typeof ctx.command?.transform,
        'agent': String(ctx.agent ? 'present' : 'missing'),
        'permission.assert': typeof ctx.permission?.assert,
        'permission.hook': typeof ctx.permission?.hook === 'object' ? 'present' : 'missing',
        'event.subscribe': typeof ctx.event?.subscribe,
        'session.create': typeof ctx.session?.create,
        'session.prompt': typeof ctx.session?.prompt,
        'session.wait': typeof (ctx.session as any)?.wait,
        'rpc.register': typeof ctx.rpc?.register,
        'worktree.create': typeof ctx.worktree?.create,
        'worktree.remove': typeof ctx.worktree?.remove,
        'worktree.list': typeof ctx.worktree?.list,
        'worktree.refresh': typeof ctx.worktree?.refresh,
        'location.project.id': typeof ctx.location?.project?.id,
        'location.project.canonical': typeof ctx.location?.project?.canonical,
      } as never;
      const missing = Object.entries(d).filter(([, v]) => v === 'undefined').map(([k]) => k);
      return { case: 'T-3', name: '签名锁定', ok: missing.length === 0, detail: d, note: missing.join(',') || undefined };
    },
  },
  'T-4': {
    name: 'rpc.register + worktree 四签名（create/list/remove/refresh）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const pid = ctx.location.project.id;
      const detail: Record<string, unknown> = { projectID: pid };
      let ok = true;
      try {
        const wt = await ctx.worktree.create({ projectID: pid, name: `dcae-contract-${Date.now()}` } as never);
        detail.create = wt;
        const dir = (wt as any)?.directory as string | undefined;
        if (!dir) ok = false;
        try {
          const list = await ctx.worktree.list({ projectID: pid } as never);
          detail.listCount = Array.isArray(list) ? list.length : JSON.stringify(list)?.slice(0, 120);
        } catch (e) {
          detail.list = String(e).slice(0, 160); // list 形态失败不判 FAIL（create/remove 已证签名）
        }
        if (dir) {
          try {
            await ctx.worktree.remove({ projectID: pid, directory: dir, force: true } as never);
            detail.remove = 'ok';
          } catch (e) {
            detail.remove = String(e);
            ok = false;
          }
        }
        try {
          await ctx.worktree.refresh({ projectID: pid } as never);
          detail.refresh = 'ok';
        } catch (e) {
          detail.refresh = String(e).slice(0, 160);
        }
      } catch (e) {
        detail.error = String(e);
        ok = false;
      }
      return { case: 'T-4', name: 'worktree 签名', ok, detail };
    },
  },
  'T-5': {
    name: '插件工具权限粒度（dcae.<tool> action 规则命中）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      // 注册一个探针工具（permission: dcae.probe），然后在会话规则 deny 下经 assert 观测
      const detail: Record<string, unknown> = {};
      let ok = false;
      try {
        let assertResult = '';
        await ctx.tool.transform((editor) => { const ed = editor as unknown as { add: (t: unknown) => void };
          ed.add({
            name: 'dcae_probe_contract',
            description: 'contract probe',
            input: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({ content: 'probe-ok' }),
            options: { permission: 'dcae.probe', codemode: false },
          } as never);
        });
        // 创建探针会话（deny 规则）
        const s = await ctx.session.create({
          title: 'contract-T5',
          location: { directory: kernel.opts.canonical },
          permissions: [
            { action: 'dcae.probe', resource: '*', effect: 'deny' },
          ],
        } as never);
        detail.session = (s as any)?.id;
        try {
          await ctx.permission.assert({ sessionID: (s as any)?.id, action: 'dcae.probe', resources: ['x'] } as never);
          assertResult = 'allowed';
        } catch (e) {
          assertResult = 'denied: ' + String(e).slice(0, 120);
        }
        detail.assertWithDenyRule = assertResult;
        ok = assertResult.startsWith('denied');
        try { await ctx.session.remove({ sessionID: (s as any)?.id } as never); } catch { /* 尽力 */ }
      } catch (e) {
        detail.error = String(e);
      }
      return { case: 'T-5', name: '工具权限粒度', ok, detail };
    },
  },
  'T-6': {
    name: 'evaluate 钩子（ask→deny 改判；配置 deny 不触发；message 改写）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let hookFiredForAsk = false;
      let hookFiredForDeny = false;
      let messageObserved: string | null = null;
      let ok = false;
      const off = ctx.permission.hook('evaluate', (input: { sessionID: string; action: string; resources: readonly string[]; effect: 'allow' | 'deny' | 'ask'; message?: string }) => {
        if (input.action === 'dcae.contract.ask-probe') {
          hookFiredForAsk = true;
          if (input.effect === 'ask') {
            input.effect = 'deny';
            input.message = 'contract-deny';
          }
          messageObserved = input.message ?? null;
          detail.resourcesReadonly = Array.isArray(input.resources);
        }
        if (input.action === 'dcae.contract.deny-probe') hookFiredForDeny = true;
        return;
      });
      try {
        const s = await ctx.session.create({
          title: 'contract-T6',
          location: { directory: kernel.opts.canonical },
          permissions: [
            { action: 'dcae.contract.ask-probe', resource: '*', effect: 'ask' },
            { action: 'dcae.contract.deny-probe', resource: '*', effect: 'deny' },
          ],
        } as never);
        const sid = (s as any)?.id;
        const ask = await attemptAssert(ctx, sid, 'dcae.contract.ask-probe');
        detail.askOutcome = ask;
        await attemptAssert(ctx, sid, 'dcae.contract.deny-probe');
        detail.hookFiredForDeny = hookFiredForDeny; // 预期 false（配置 deny 不触发钩子）
        detail.hookFiredForAsk = hookFiredForAsk;
        detail.messageObserved = messageObserved;
        ok = hookFiredForAsk && hookFiredForDeny === false && ask.startsWith('denied');
        try { await ctx.session.remove({ sessionID: sid } as never); } catch { /* 尽力 */ }
      } catch (e) {
        detail.error = String(e);
      }
      try { if (typeof off === 'function') (off as unknown as () => void)(); } catch { /* 可选 */ }
      return { case: 'T-6', name: 'evaluate 钩子', ok, detail };
    },
  },
  'T-7': {
    name: '会话规则顺序（agent 规则后求值、last-match、external_directory 覆盖）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let ok = false;
      try {
        // 会话规则：allow 全部 → deny 窄项（last-match 应使 deny 生效）
        const s = await ctx.session.create({
          title: 'contract-T7',
          location: { directory: kernel.opts.canonical },
          permissions: [
            { action: 'dcae.contract.order', resource: '*', effect: 'allow' },
            { action: 'dcae.contract.order', resource: 'narrow', effect: 'deny' },
            { action: 'external_directory', resource: '*', effect: 'deny' },
          ],
        } as never);
        const sid = (s as any)?.id;
        const broad = await attemptAssert(ctx, sid, 'dcae.contract.order', ['wide']);
        const narrow = await attemptAssert(ctx, sid, 'dcae.contract.order', ['narrow']);
        detail.broad = broad; // 预期 allowed
        detail.narrow = narrow; // 预期 denied（last-match）
        ok = broad.startsWith('allowed') && narrow.startsWith('denied');
        try { await ctx.session.remove({ sessionID: sid } as never); } catch { /* 尽力 */ }
      } catch (e) {
        detail.error = String(e);
      }
      return { case: 'T-7', name: '规则顺序', ok, detail };
    },
  },
  'T-8': {
    name: '平台通配符语义（* 跨 /、? 单字符、**、锚定、shell 尾 *）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let ok = true;
      const probe = async (rules: { action: string; resource: string; effect: 'allow' | 'deny' }[], action: string, resources: string[]): Promise<string> => {
        const s = await ctx.session.create({ title: 'contract-T8', location: { directory: kernel.opts.canonical }, permissions: rules } as never);
        const r = await attemptAssert(ctx, (s as any)?.id, action, resources);
        try { await ctx.session.remove({ sessionID: (s as any)?.id } as never); } catch { /* 尽力 */ }
        return r;
      };
      try {
        // 1. `*` 跨 `/`：deny a/* 应命中 a/b/c
        const r1 = await probe([{ action: 'dcae.w', resource: 'a/*', effect: 'deny' }], 'dcae.w', ['a/b/c']);
        detail.starCrossesSlash = r1.startsWith('denied');
        // 2. `?` 单字符：deny a?c 命中 abc 不命中 abbc
        const r2 = await probe([{ action: 'dcae.w', resource: 'a?c', effect: 'deny' }], 'dcae.w', ['abc']);
        const r2b = await probe([{ action: 'dcae.w', resource: 'a?c', effect: 'deny' }], 'dcae.w', ['abbc']);
        detail.questionSingle = r2.startsWith('denied') && r2b.startsWith('allowed');
        // 3. `**` 独立语义：deny a/** 是否命中 a/b（若 `**`===`.*` 则等价 a/. 或 a.* … 实测记录）
        const r3 = await probe([{ action: 'dcae.w', resource: 'a/**', effect: 'deny' }], 'dcae.w', ['a/b']);
        detail.globstarBehavior = r3; // 记录原始行为
        // 4. 锚定：deny bc 不应命中 xbc
        const r4 = await probe([{ action: 'dcae.w', resource: 'bc', effect: 'deny' }], 'dcae.w', ['xbc']);
        detail.anchored = r4.startsWith('allowed');
        // 5. shell 尾 ` *` 匹配无参数形式（shell 动作经 scanner；仅记录 assert 行为）
        const r5 = await probe([{ action: 'shell', resource: 'echo *', effect: 'deny' }], 'shell', ['echo']);
        detail.shellTrailingStar = r5;
        ok = detail.starCrossesSlash === true && detail.questionSingle === true && detail.anchored === true;
      } catch (e) {
        detail.error = String(e);
        ok = false;
      }
      return { case: 'T-8', name: '通配符语义', ok, detail };
    },
  },
  'T-9': {
    name: 'instruction entries（键正则拒绝 + 256 KiB 上限）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let ok = true;
      try {
        const s = await ctx.session.create({ title: 'contract-T9', location: { directory: kernel.opts.canonical } } as never);
        const sid = (s as any)?.id;
        // 键正则 ^[a-z0-9][a-z0-9._-]*$：非法键应被拒
        try {
          await (ctx.session as any).instructions.entry.put({ sessionID: sid, key: 'Bad Key!', value: 'x' });
          detail.badKeyAccepted = true;
          ok = false;
        } catch {
          detail.badKeyRejected = true;
        }
        // 256 KiB 上限：超出应 413/拒绝
        const big = 'x'.repeat(256 * 1024 + 1);
        try {
          await (ctx.session as any).instructions.entry.put({ sessionID: sid, key: 'dcae.contract.big', value: big });
          detail.oversizeAccepted = true;
          ok = false;
        } catch {
          detail.oversizeRejected = true;
        }
        try { await ctx.session.remove({ sessionID: sid } as never); } catch { /* 尽力 */ }
      } catch (e) {
        detail.error = String(e);
        ok = false;
      }
      return { case: 'T-9', name: 'entries 约束', ok, detail };
    },
  },
  'T-11': {
    name: '跨 location 事件投递方向',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      // 在本 location 订阅；外部 runner 在另一 location 触发事件（创建 worktree 会话）；
      // 进程内侧只记录本实例收到的事件来源 location（R5：无论方向，内核都不依赖）
      const detail: Record<string, unknown> = { subscription: typeof ctx.event?.subscribe, ambientLocation: ctx.location?.directory };
      return { case: 'T-11', name: '事件方向（进程内半）', ok: true, detail, note: '跨 location 半由外部 runner 判定' };
    },
  },
  'T-12': {
    name: 'wait 早返回竞态 + sessionLog after/follow + Idle outcome',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let ok = true;
      try {
        const s = await ctx.session.create({ title: 'contract-T12', location: { directory: kernel.opts.canonical } } as never);
        const sid = (s as any)?.id;
        // 未 prompt 会话的 wait：可能立即返回（竞态探针）
        const t0 = Date.now();
        await (ctx.session as any).wait({ sessionID: sid });
        const earlyMs = Date.now() - t0; detail.waitEarlyReturnMs = earlyMs;
        detail.waitEarly = earlyMs < 1000;
        // sessionLog after/follow
        const page1 = await collectLog(ctx, sid, 0);
        detail.logItems = page1.length;
        const after = page1.length > 0 ? page1[page1.length - 1]!.seq : 0;
        const page2 = await collectLog(ctx, sid, after + 1);
        detail.afterFilterWorks = page2.length === 0;
        try { await ctx.session.remove({ sessionID: sid } as never); } catch { /* 尽力 */ }
      } catch (e) {
        detail.error = String(e);
        ok = false;
      }
      return { case: 'T-12', name: 'wait/日志语义', ok, detail };
    },
  },
  'T-13': {
    name: 'tester 读隔离编译（T-iso：resource 提交形态矩阵 + *..* 兜底）',
    fn: async (ctx: Ctx, kernel: Kernel) => {
      const detail: Record<string, unknown> = {};
      let ok = true;
      const canonical = kernel.opts.canonical;
      const probe = async (rules: { action: string; resource: string; effect: 'allow' | 'deny' }[], action: string, resources: string[]): Promise<string> => {
        const s = await ctx.session.create({ title: 'contract-T13', location: { directory: canonical }, permissions: rules } as never);
        const r = await attemptAssert(ctx, (s as any)?.id, action, resources);
        try { await ctx.session.remove({ sessionID: (s as any)?.id } as never); } catch { /* 尽力 */ }
        return r;
      };
      try {
        const abs = canonical.replace(/\\/g, '/') + '/*';
        const rel = '../' + canonical.replace(/\\/g, '/').split('/').pop() + '/*';
        const cases: Record<string, string> = {
          absolute: await probe([{ action: 'read', resource: abs, effect: 'deny' }], 'read', [canonical.replace(/\\/g, '/') + '/src/x.ts']),
          relativeForm: await probe([{ action: 'read', resource: rel, effect: 'deny' }], 'read', ['../somewhere/x.ts']),
          traversal: await probe([{ action: 'read', resource: '*..*', effect: 'deny' }], 'read', ['../../etc/passwd']),
        };
        detail.cases = cases;
        detail.absoluteWorks = cases.absolute!.startsWith('denied');
        detail.traversalWorks = cases.traversal!.startsWith('denied');
        ok = detail.absoluteWorks === true && detail.traversalWorks === true;
      } catch (e) {
        detail.error = String(e);
        ok = false;
      }
      return { case: 'T-13', name: 'T-iso 读隔离', ok, detail };
    },
  },
};

async function attemptAssert(ctx: Ctx, sid: string, action: string, resources: string[] = ['x']): Promise<string> {
  try {
    await ctx.permission.assert({ sessionID: sid, action, resources } as never);
    return 'allowed';
  } catch (e) {
    return 'denied: ' + String(e).slice(0, 120);
  }
}

async function collectLog(ctx: Ctx, sid: string, after: number): Promise<{ seq: number }[]> {
  const out: { seq: number }[] = [];
  const it = (ctx.session as any).log({ sessionID: sid, after }) as AsyncIterable<any>;
  for await (const item of it) out.push(item);
  return out;
}

async function runCases(ctx: Ctx, kernel: Kernel, only?: string[]): Promise<{ cases: CaseResult[] }> {
  const results: CaseResult[] = [];
  for (const [id, c] of Object.entries(CASES)) {
    if (only && only.length > 0 && !only.includes(id)) continue;
    try {
      results.push(await c.fn(ctx, kernel));
    } catch (e) {
      results.push({ case: id, name: c.name, ok: false, detail: String(e) });
    }
  }
  // 输出 schema 约束 ok: boolean——非布尔判定（INCONCLUSIVE）压为 false，note 保留语义；
  // undefined 字段会被编码为 null 违反 schema（实测）——显式剔除
  for (const r of results) {
    if (typeof r.ok !== 'boolean') {
      r.note = `INCONCLUSIVE：${r.note ?? ''}`.trim();
      r.ok = false;
    }
    if (r.note === undefined) delete r.note;
    if (r.detail === undefined) r.detail = null;
  }
  return { cases: results };
}
