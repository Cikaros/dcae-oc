/**
 * DCAE-OC 插件入口（R1/R9；1.4 §5.2）。
 * setup 只做同步注册：六工具、权限钩子、命令占位、RPC（+ contract 探针）；
 * 内核初始化（配置/索引/快照重放）异步执行，ready 前不 dispatch。
 * 角色智能体文件缺失即拒绝启动（fail closed，1.4 §2 #1b）。
 */
import { Plugin } from '@opencode/plugin';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireKernel, peekKernel } from './kernel/registry.ts';
import { Kernel } from './kernel/kernel.ts';
import { KernelConfigSchema } from './schema/common.ts';
import { registerTools } from './tools/register.ts';
import { registerPermissionHook } from './hooks/permission.ts';
import { registerRpc } from './rpc/status.ts';
import { createOpenCodeHost } from './host/opencode.ts';
import { toPosix } from './util/paths.ts';

const AGENT_FILES = ['dcae-planner.md', 'dcae-dev.md', 'dcae-tester.md', 'dcae-reviewer.md'] as const;

export default Plugin.define({
  id: 'dcae',
  async setup(ctx) {
    const t0 = Date.now();
    const canonical = toPosix(ctx.location.project.canonical);
    const projectID = ctx.location.project.id;

    // setup 探针（仅契约模式启用；诊断插件装载链路——M0 实测的关键取证工具）
    const contractMode = process.env.DCAE_CONTRACT === '1';
    const probe = (stage: string, err?: unknown): void => {
      if (!contractMode) return;
      try {
        const { mkdirSync, appendFileSync } = require('node:fs') as typeof import('node:fs');
        mkdirSync(join(canonical, '.dcae'), { recursive: true });
        appendFileSync(join(canonical, '.dcae', 'setup-probe.log'), `${new Date().toISOString()} ${stage}${err !== undefined ? ` ERROR: ${String(err)}` : ''}\n`);
      } catch { /* 探针失败不影响主流程 */ }
    };
    probe('setup-enter');
    if (contractMode) {
      // 运行时方法集侦察：SessionDomain 只是 Pick 子集，运行时对象可能携带更多域（messages 等）
      probe('session-keys: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.session) ?? {}).concat(Object.keys(ctx.session ?? {})).join(','));
    }

    // fail closed：角色智能体必须已由 dcae init 落地（1.4 §2 #1b）
    const agentsDir = join(canonical, '.opencode', 'agents');
    const missing: string[] = [];
    for (const f of AGENT_FILES) {
      if (!existsSync(join(agentsDir, f))) missing.push(f);
    }
    if (missing.length > 0) {
      throw new Error(
        `[dcae] 角色智能体缺失：${missing.join(', ')}（应位于 .opencode/agents/）。请先运行 dcae init——插件拒绝启动（fail closed，1.4 §2 #1b）。`,
      );
    }

    // 内核（进程级单例，R2/R3；契约模式下沿用既有内核）
    const options = KernelConfigSchema.partial().parse((ctx.options ?? {}) as Record<string, unknown>);
    if (process.env.DCAE_CONTRACT === '1' && options.serverUrl === undefined && process.env.DCAE_OPENCODE_URL) {
      options.serverUrl = process.env.DCAE_OPENCODE_URL;
    }
    const handle = acquireKernel(
      { directory: toPosix(ctx.location.directory), projectID, canonical },
      () => new Kernel({ canonical, projectID, config: options }),
    );
    const kernel = handle.kernel;
    const instanceId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const isCanonical = toPosix(ctx.location.directory) === canonical;
    kernel.attachInstance(instanceId, () => createOpenCodeHost({ ctx, httpBase: options.serverUrl }), isCanonical, toPosix(ctx.location.directory));

    // R1：每实例注册全套（工具目录按 location 生效，任务会话运行在 worktree location）
    try { registerTools(ctx, kernel); probe('registerTools-ok'); } catch (e) { probe('registerTools', e); throw e; }
    try { registerPermissionHook(ctx, kernel); probe('permissionHook-ok'); } catch (e) { probe('permissionHook', e); throw e; }
    try {
      const { registerCommands } = await import('./commands/register.ts');
      registerCommands(ctx, kernel);
      probe('commands-ok');
    } catch (e) { probe('commands', e); throw e; }
    if (process.env.DCAE_CONTRACT === '1') {
      // 契约模式：单一 id 'dcae' 定义（含 status + contract 方法）——同 id 重复注册会冲突
      const { registerContractRpc } = await import('./rpc/contract.ts');
      try { await registerContractRpc(ctx, kernel); probe('contractRpc-ok'); } catch (e) { probe('contractRpc', e); throw e; }
    } else {
      try { await registerRpc(ctx, kernel); probe('rpc-ok'); } catch (e) { probe('rpc', e); throw e; }
    }

    // 内核初始化（异步，R9）+ 事件订阅（R5：只做唤醒）
    const initPromise = kernel.ready ? Promise.resolve() : kernel.init();
    void initPromise.then(async () => {
      if (!kernel.isLeader()) return;
      const { Scheduler } = await import('./kernel/scheduler.ts');
      if (!kernel.scheduler) {
        kernel.scheduler = new Scheduler(kernel);
        kernel.onWake(() => void kernel.scheduler!.tick());
      }
      kernel.scheduler.start();
    });
    const unsubscribe = ctx.event.subscribe();
    void (async () => {
      try {
        for await (const _ev of unsubscribe) {
          kernel.wake(); // 事件只做唤醒；状态推进由有界轮询 + 会话日志重放为权威（R5）
        }
      } catch {
        // 事件流易失（慢消费者溢出即断 [A]）：唤醒循环由心跳兜底
      }
    })();

    const cleanup = async () => {
      kernel.detachInstance(instanceId);
      handle.release(); // R3：最后一个实例 release 停内核
    };
    kernel.log.info('index', '实例 setup 完成', { instanceId, ms: Date.now() - t0, canonicalInstance: isCanonical, options: options, rawOptionsType: typeof ctx.options, rawOptions: (ctx.options as unknown) ?? null });
    return cleanup;
  },
});

export { peekKernel };
