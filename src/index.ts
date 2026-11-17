/**
 * DCAE-OC 插件入口。
 * setup 只做同步注册：六工具、权限钩子、命令占位、RPC（+ contract 探针）；
 * 内核初始化（配置/索引/快照重放）异步执行，ready 前不 dispatch。
 *
 * 全局安装的插件会在每个 location 执行 setup；因此对非 DCAE 项目**静默跳过**（不建内核、
 * 不注册工具、不抛错），仅在探测到 DCAE 项目信号后激活。缺失脚手架时降级为未就绪，
 * 由用户显式执行 /dcae-init 初始化——不再因缺文件而拒绝启动。
 */
import { Plugin } from '@opencode/plugin';
import { join } from 'node:path';
import { acquireKernel, peekKernel } from './kernel/registry.ts';
import { Kernel } from './kernel/kernel.ts';
import { parseIdleEvent } from './kernel/idle-signal.ts';
import { KernelConfigSchema } from './schema/common.ts';
import { registerTools } from './tools/register.ts';
import { registerPermissionHook } from './hooks/permission.ts';
import { registerRpc } from './rpc/status.ts';
import { createOpenCodeHost } from './host/opencode.ts';
import { toPosix } from './util/paths.ts';
import { detectDcaeProject, agentsPresent } from './init/detect.ts';

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

    // 项目意图探测（只读、无副作用）。契约模式恒激活（契约测试直连探针）。
    // 非 DCAE 项目静默跳过：不注册任何东西、不建内核（Kernel 构造会 mkdir .dcae）、不抛错。
    let active = contractMode;
    if (!active) {
      const det = detectDcaeProject(canonical);
      if (det.isDcaeProject) {
        active = true;
      } else {
        // 非 DCAE 项目：注册 /dcae-init 供用户显式初始化，其余一律不激活。
        try {
          const { registerInitCommand } = await import('./commands/register.ts');
          registerInitCommand(ctx);
        } catch { /* 命令注册失败不影响宿主 */ }
        return;
      }
    }

    // 角色智能体齐备性：缺失不再是致命错误，降级为「未就绪」（不调度）。
    // 用户可显式执行 /dcae-init 补齐脚手架。
    const agents = agentsPresent(canonical);
    const ready = agents.ok;
    if (!ready) {
      probe('agents-missing', agents.missing.join(','));
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
    kernel.attachInstance(
      instanceId,
      () => createOpenCodeHost({ ctx, httpBase: options.serverUrl, idleSignal: (sid, since) => kernel.idleSince(sid, since) }),
      isCanonical,
      toPosix(ctx.location.directory),
    );

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

    // 未就绪（角色智能体缺失）：不启动调度器；内核保持冷态，待 /dcae-init 后重生。
    if (!ready) {
      const cleanupCold = async (): Promise<void> => {
        kernel.detachInstance(instanceId);
        handle.release();
      };
      kernel.log.warn('index', '角色智能体缺失：内核保持未就绪（执行 /dcae-init 后重新加载）', { missing: agents.missing, canonicalInstance: isCanonical });
      return cleanupCold;
    }

    // 内核初始化（异步，R9）+ 事件订阅（R5：只做唤醒）
    // Scheduler 无论 leader/follower 都启动——tick 内含 follower 接管循环
    // （实测缺陷 11：仅 leader 创建 Scheduler 时，leader 死亡后无任何实例能接管）
    const initPromise = kernel.ready ? Promise.resolve() : kernel.init();
    void initPromise.then(async () => {
      const { Scheduler } = await import('./kernel/scheduler.ts');
      if (!kernel.scheduler) {
        kernel.scheduler = new Scheduler(kernel);
        kernel.onWake(() => void kernel.scheduler!.tick());
      }
      kernel.scheduler.start();
    });
    const unsubscribe = ctx.event.subscribe();
    const hangProbeMod = process.env.DCAE_PROBE === '1' ? await import('./diagnostics/hang-probe.ts') : null;
    void (async () => {
      try {
        for await (const ev of unsubscribe) {
          // 事件消费护栏（假死定位探针：事件循环停止时最后一条记录即堵点）
          if (hangProbeMod) hangProbeMod.hangProbe.probeLog(canonical, `event ${String((ev as any)?.type ?? '?')}`);
          kernel.wake(); // 事件只做唤醒；状态推进由有界轮询 + 会话日志重放为权威（R5）
          // 会话 idle/终态事件登记（awaitIdle 的进程内信号）。
          // 平台事件负载为 { type, data: { sessionID, ... } }；解析见 kernel/idle-signal.ts，
          // 回归测试见 test/unit/idle-signal.test.ts。
          const parsed = parseIdleEvent(ev);
          if (parsed) kernel.noteSessionIdle(parsed.sessionID, parsed.signal);
        }
      } catch {
        // 事件流易失（慢消费者溢出即断）：唤醒循环由心跳兜底
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
