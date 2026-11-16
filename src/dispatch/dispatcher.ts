/**
 * Dispatcher —— READY→RUNNING 的 dispatch 序列（1.4 §7.1 守卫实现；架构设计 §3.8/§6.1）。
 * 原子施加：permissions + metadata 在会话创建时一次给入（1.4 dispatch 原子化，P0-3 落实）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../kernel/kernel.ts';
import type { TaskDef } from '../schema/task.ts';
import { compile, type Role } from '../policy/compile.ts';
import { loadGates } from '../gates/runner.ts';
import { hashPaths } from './audit.ts';
import { sessionId, messageId } from '../util/ulid.ts';
import { worktreeList, currentSha } from '../util/git.ts';
import { buildContextEntry } from '../context/resolver.ts';

export interface DispatchOutcome {
  ok: boolean;
  detail?: string;
  sessionId?: string;
}

/** dev 任务 dispatch（tester dispatch 同构，见 dispatchTester）。 */
export async function dispatchTask(kernel: Kernel, task: TaskDef): Promise<DispatchOutcome> {
  return dispatchRole(kernel, task, 'dev');
}

export async function dispatchTester(kernel: Kernel, task: TaskDef): Promise<DispatchOutcome> {
  return dispatchRole(kernel, task, 'tester');
}

/** reviewer 调度（审查闭环；REVIEW 态由 Scheduler 调用）。 */
export async function dispatchReviewer(kernel: Kernel, task: TaskDef): Promise<DispatchOutcome> {
  return dispatchRole(kernel, task, 'reviewer');
}

export async function dispatchRole(kernel: Kernel, task: TaskDef, role: Role): Promise<DispatchOutcome> {
  const t = kernel.projection.task(task.id);
  const t0 = Date.now();
  // 写前验证（非幂等宿主动作前重读租约，缩小脑裂窗口）
  if (!kernel.lease.verify()) return { ok: false, detail: '租约已丢失，放弃 dispatch' };

  // 1. worktree 基线：**有 deps 的任务从 refs/dcae/integration 分叉**（依赖任务的产物经合并列车
  //    进入 integration——canonical HEAD 在 promote 前不含它们，实测 dev 问题 INBOX-000002）；
  //    无 deps 任务从 canonical HEAD 分叉（含盲测提交，1.4 §6.6）。
  //    实测：create 起始 ref 走 branch 参数（from=源目录语义）；幂等复用防重名增殖。
  const baseRef = task.deps.length > 0 ? 'refs/dcae/integration' : 'HEAD';
  const forkSha = currentSha(kernel.opts.canonical, baseRef) ?? currentSha(kernel.opts.canonical, 'HEAD') ?? '';
  const wtName = `dcae-${task.id.toLowerCase()}-a${t.attempt}`;
  let worktreeDir: string | undefined;
  try {
    const existing = (await kernel.host().listWorktrees(kernel.opts.projectID)) ?? [];
    const hit = existing.find((w) => normalizeWt(w.directory).endsWith('/' + wtName));
    if (hit && existsSync(hit.directory)) {
      worktreeDir = hit.directory;
    } else if (hit) {
      // 死注册（物理目录已删）：清注册后重建
      try { await kernel.host().removeWorktree(kernel.opts.projectID, hit.directory, true); } catch { /* 尽力 */ }
    }
  } catch { /* list 不可用：直接 create（平台会自建） */ }
  if (!worktreeDir) {
    try {
      const wt = await kernel.host().createWorktree(kernel.opts.projectID, wtName, {
        branch: forkSha,
      });
      worktreeDir = wt.directory;
    } catch (e) {
      const msg = String(e);
      if (/missing|registered|WorktreeError/i.test(msg)) {
        // 自愈（实测：目录被外部删除后注册残留 → "missing but registered"）：prune 清注册后重试一次
        const { git } = await import('../util/git.ts');
        git(kernel.opts.canonical, ['worktree', 'prune']);
        try {
          const wt = await kernel.host().createWorktree(kernel.opts.projectID, wtName, { branch: forkSha });
          worktreeDir = wt.directory;
          kernel.log.info('dispatch', 'worktree 注册残留已 prune 并重建', { taskId: task.id });
        } catch (e2) {
          return { ok: false, detail: `worktree 创建失败（prune 后重试仍失败）：${String(e2)}` };
        }
      } else {
        return { ok: false, detail: `worktree 创建失败：${msg}` };
      }
    }
  }
  if (!worktreeDir || !existsSync(worktreeDir)) return { ok: false, detail: `worktree 目录无效：${worktreeDir}` };

  // 2. blind 任务：核对 acceptance 哈希（1.4 §6.6 第 6 步）
  if (task.blind_tests && role === 'dev') {
    const recorded = t.lastTestCommitHash;
    const files = listAcceptance(worktreeDir, task.id);
    const local = hashPaths(worktreeDir, files);
    if (recorded && local !== recorded) {
      return { ok: false, detail: `acceptance 哈希不一致（记录 ${recorded} vs 本地 ${local}），拒绝 dispatch` };
    }
  }

  // 3. 权限编译（V2 有序规则数组）
  const gates = loadGates(kernel.opts.canonical);
  const prefixes: Record<string, string[]> = {};
  for (const [id, c] of Object.entries(gates?.commands ?? {})) prefixes[id] = c.argv;
  const canonicalWorktrees = worktreeList(kernel.opts.canonical).map((w) => w.replace(/\\/g, '/'));
  const { rules } = compile(task, role, {
    canonicalDir: kernel.opts.canonical,
    worktreeDir,
    allWorktreeDirs: canonicalWorktrees,
    commandPrefixes: prefixes,
    config: kernel.config,
  });

  // 4. 原子创建会话（permissions 与 metadata 创建时一次给入；location 仅 {directory}）
  // 模型：config.model（provider/id）显式传给会话——宿主默认模型可能是 free 限额模型（实测教训）。
  const sid = sessionId();
  const modelRef = parseModelRef(kernel.config.model);
  try {
    await kernel.host().createSession({
      id: sid,
      directory: worktreeDir,
      agent: `dcae-${role}`,
      title: `${task.id} · ${role} · attempt ${t.attempt}`,
      ...(modelRef ? { model: modelRef } : {}),
      permissions: rules,
      metadata: { task: task.id, attempt: t.attempt, role, kernelId: kernel.kernelId },
    });
  } catch (e) {
    return { ok: false, detail: `会话创建失败：${String(e)}` };
  }
  // 登记会话 location（ctx.session 域 per-location——后续调用必须路由到该 location 的实例）
  kernel.recordSessionLocation(sid, worktreeDir);

  // 5. 环境白名单（PUT 整体替换）
  try {
    await kernel.hostForSession(sid).setEnvironment(sid, {
      DCAE_TASK: task.id,
      DCAE_ATTEMPT: String(t.attempt),
      DCAE_ROLE: role,
    });
  } catch { /* 环境替换失败不阻塞（非权威防线） */ }

  // 6. 常驻上下文 entries（≤256 KiB 编译期拒绝在 HostPort.putInstruction 内）
  try {
    const entry = buildContextEntry(kernel, task, role);
    await kernel.hostForSession(sid).putInstruction(sid, 'dcae.task', entry);
  } catch (e) {
    kernel.log.warn('dispatch', 'instruction entry 写入失败（后备：admission 文本携带）', { error: String(e) });
  }

  // 7. admission prompt
  const admissionId = messageId();
  try {
    await kernel.hostForSession(sid).prompt(sid, admissionText(task, role, t.attempt), { messageId: admissionId, delivery: 'steer' });
  } catch (e) {
    return { ok: false, detail: `admission prompt 失败：${String(e)}` };
  }

  // 8. 事件：dev dispatch = READY→RUNNING 迁移；tester/reviewer 仅追加无迁移标记
  //    （dispatch 对非 dev 角色不得改变状态——曾致 REVIEW→RUNNING 错乱、reviewLoop 失效）
  const closureHash = computeClosureHash(kernel, task);
  const data = {
    sessionId: sid,
    worktree: worktreeDir,
    forkSha,
    admissionId,
    closureHash,
    attempt: t.attempt,
    role,
    key: `dispatch:${task.id}:${role}:${t.attempt}`,
  };
  if (role === 'dev') {
    const ev = kernel.appendTransition(t, 'dispatch', data);
    if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
  } else {
    const ev = kernel.appendMarkForTask(t, 'dispatch', data);
    if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
  }
  kernel.log.info('dispatch', 'dispatch 完成', { task: task.id, role, sessionId: sid, ms: Date.now() - t0 });
  return { ok: true, sessionId: sid };
}

/** 解析 `provider/id` 模型引用；空/非法返回 undefined。 */
function parseModelRef(ref: string | undefined): { id: string; providerID: string; variant?: string } | undefined {
  if (!ref || !ref.includes('/')) return undefined;
  const i = ref.indexOf('/');
  const providerID = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return providerID && id ? { id, providerID } : undefined;
}

function normalizeWt(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function admissionText(task: TaskDef, role: Role, attempt: number): string {
  if (role === 'reviewer') {
    return [
      `你是 DCAE 任务 ${task.id} 的审查者。直接阅读 worktree 中的源文件进行审查（shell 不可用，不做 diff）。`,
      '零写、零 shell。审查完成后，最后一条消息的最后一行必须是以下之一（内核机器解析）：',
      'verdict: approve',
      'verdict: request_changes',
      'verdict: escalate',
      'request_changes/escalate 时在之前列出 findings（severity/claim/file/建议 verify 命令）。',
    ].join('\n');
  }
  const lines = [
    `你是 DCAE 任务 ${task.id} 的 ${role}（attempt ${attempt}）。目标：${task.objective}`,
    `重要：完成实现且自测通过后，必须立即调用 dcae_submit 工具（参数 summary）结束——这是任务完成的唯一信号；不要在可提交后继续打磨。受阻时调用 dcae_question。`,
    role === 'tester'
      ? '在 acceptance/<task>/ 下编写盲测验收测试，完成后调用 dcae_test_submit {paths}。不得读取 scratch 之外的实现。'
      : `写范围：${task.scope.write.join(', ') || '(见任务定义)'}；shell 仅限命令表白名单（test 等）。`,
  ];
  return lines.join('\n');
}

function listAcceptance(dir: string, taskId: string): string[] {
  const out: string[] = [];
  const root = join(dir, 'acceptance', taskId);
  if (!existsSync(root)) return out;
  walk(root, '');
  return out;

  function walk(p: string, rel: string): void {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(p, e.name), r);
      else out.push(`acceptance/${taskId}/${r}`);
    }
  }
}

function computeClosureHash(kernel: Kernel, task: TaskDef): string {
  const paths = [
    ...task.spec_refs.map((s) => `specs/${s}.md`),
    ...task.acceptance_tests,
    'gates.yaml',
  ];
  return hashPaths(kernel.opts.canonical, paths);
}
