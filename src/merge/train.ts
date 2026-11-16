/**
 * MergeTrain —— 串行受控合并（1.4 §6.7；架构设计 §6.4）。
 * refs/dcae/integration（内核唯一写者）；refs/dcae/accepted/<task>（冻结 ref）；
 * .dcae/merge/ 内核专用合并工作树。冲突三分支：基线漂移→rebase→重验证；rebase 冲突→BLOCKED；范围外→FAILED+告警。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '../kernel/kernel.ts';
import { git, revParse, updateRef, currentSha } from '../util/git.ts';
import { loadGates } from '../gates/runner.ts';
import { EvidenceStore } from '../evidence/store.ts';
import { dcaeGlobMatch } from '../util/glob.ts';
import { normalizeForMatch } from '../util/paths.ts';

const INTEGRATION_REF = 'refs/dcae/integration';

export function acceptedRef(taskId: string): string {
  return `refs/dcae/accepted/${taskId}`;
}

/** REVIEW→ACCEPTED 时建冻结 ref（dev 后续 amend/rebase 不影响合并）。 */
export function freezeTask(kernel: Kernel, taskId: string, worktree: string): string | null {
  const sha = currentSha(worktree, 'HEAD');
  if (!sha) return null;
  if (!updateRef(kernel.opts.canonical, acceptedRef(taskId), sha)) return null;
  kernel.appendMarkForTask(kernel.projection.task(taskId), 'frozen-ref', { sha, ref: acceptedRef(taskId) });
  return sha;
}

/** 合并工作树准备（检出 integration；一次性创建后 reset）。 */
function ensureMergeWorktree(kernel: Kernel): string | null {
  const dir = join(kernel.dcaeDir, 'merge');
  if (!existsSync(join(dir, '.git'))) {
    const head = revParse(kernel.opts.canonical, INTEGRATION_REF) ?? currentSha(kernel.opts.canonical, 'HEAD');
    if (!head) return null;
    const r = git(kernel.opts.canonical, ['worktree', 'add', '--detach', dir, head]);
    if (!r.ok) return null;
  }
  const head = revParse(kernel.opts.canonical, INTEGRATION_REF) ?? currentSha(kernel.opts.canonical, 'HEAD');
  if (!head) return null;
  git(dir, ['reset', '--hard', head]);
  git(dir, ['clean', '-fd']);
  return dir;
}

/** 串行合并一个 ACCEPTED 任务（按 ACCEPTED 事件 seq 排队由调度层保证逐节处理）。 */
export async function mergeOne(kernel: Kernel, taskId: string): Promise<{ ok: boolean; detail?: string }> {
  const t = kernel.projection.task(taskId);
  if (t.state !== 'ACCEPTED') return { ok: false, detail: `状态非 ACCEPTED：${t.state}` };
  const frozen = revParse(kernel.opts.canonical, acceptedRef(taskId));
  if (!frozen) return { ok: false, detail: '冻结 ref 缺失' };
  const mergeDir = ensureMergeWorktree(kernel);
  if (!mergeDir) return { ok: false, detail: '合并工作树不可用' };

  // 1. git merge --no-ff <frozen>
  const merge = git(mergeDir, ['merge', '--no-ff', frozen]);
  if (!merge.ok) {
    // 2. 冲突分类
    const conflicted = conflictedFiles(mergeDir);
    const scopes = collectAcceptedScopes(kernel);
    const inScope = conflicted.every((f) => scopes.some((g) => dcaeGlobMatch(g, f)));
    git(mergeDir, ['merge', '--abort']);
    if (!inScope) {
      // 范围外写入 → 本不该到达此处（事后 diff 已拦截）：FAILED + 告警
      kernel.appendTransition(t, 'merge-fail', { reason: 'out-of-scope-conflict', conflicted, alert: true });
      return { ok: false, detail: `范围外冲突（告警已记录）：${conflicted.slice(0, 3).join(', ')}` };
    }
    // 基线漂移 → 重定基到当前 integration head
    const rebased = rebaseFrozen(kernel, mergeDir, taskId, frozen);
    if (!rebased.ok) {
      // 重定基冲突 → ACCEPTED→BLOCKED（inbox：新基线重试/人工解决/取消）
      kernel.appendTransition(t, 'rebase-conflict', { conflicted });
      const { createInboxItem } = await import('../inbox/inbox.ts');
      createInboxItem(kernel, {
        kind: 'escalation',
        task: taskId,
        question: `重定基冲突（${taskId}）：${conflicted.slice(0, 3).join(', ')}。新基线重试 / 人工解决 / 取消？`,
        options: [
          { id: 'new-baseline', label: '新基线重试（新 attempt）' },
          { id: 'manual', label: '人工解决' },
          { id: 'cancel', label: '取消' },
        ],
      });
      return { ok: false, detail: '重定基冲突 → BLOCKED' };
    }
    // 干净 → 在重定基 sha 上重跑全量门禁（kind: merge，commit 记重定基 sha）
    const rebasedSha = rebased.sha;
    if (!rebasedSha) return { ok: false, detail: '重定基后 sha 缺失' };
    const regate = await runGlobalGates(kernel, mergeDir, taskId, rebasedSha);
    if (!regate.ok) {
      kernel.appendTransition(t, 'merge-fail', { reason: 'post-rebase-gates', signature: regate.signature });
      return { ok: false, detail: '重定基后全局门禁失败' };
    }
    updateRef(kernel.opts.canonical, INTEGRATION_REF, rebasedSha);
    kernel.appendTransition(t, 'merge-ok', { sha: rebased.sha, via: 'rebase' });
    return { ok: true };
  }

  // 3. 合并后在 integration 上跑全局门禁
  const mergedSha = currentSha(mergeDir, 'HEAD');
  if (!mergedSha) return { ok: false, detail: '合并后 sha 缺失' };
  const gates = await runGlobalGates(kernel, mergeDir, taskId, mergedSha);
  if (!gates.ok) {
    // 失败 → integration 回滚至前一 head；任务 FAILED
    const prev = revParse(kernel.opts.canonical, INTEGRATION_REF);
    if (prev) git(mergeDir, ['reset', '--hard', prev]);
    kernel.appendTransition(t, 'merge-fail', { signature: gates.signature, reason: 'global-gates' });
    return { ok: false, detail: '全局门禁失败，integration 已回滚' };
  }
  updateRef(kernel.opts.canonical, INTEGRATION_REF, mergedSha);
  kernel.appendTransition(t, 'merge-ok', { sha: mergedSha });
  return { ok: true };
}

function conflictedFiles(dir: string): string[] {
  const r = git(dir, ['diff', '--name-only', '--diff-filter=U']);
  return r.stdout.split('\n').map((s) => normalizeForMatch(s.trim())).filter(Boolean);
}

function collectAcceptedScopes(kernel: Kernel): string[] {
  const out: string[] = [];
  for (const t of kernel.projection.tasks.values()) {
    if (t.state !== 'ACCEPTED' && t.state !== 'MERGED') continue;
    const def = kernel.taskDef(t.id);
    if (def) out.push(...def.scope.write);
  }
  return out;
}

/** git rebase --onto integration <frozen>~1 <frozen>（临时分支执行；干净返回新 sha）。 */
function rebaseFrozen(kernel: Kernel, mergeDir: string, taskId: string, frozen: string): { ok: boolean; sha?: string } {
  const integHead = revParse(kernel.opts.canonical, INTEGRATION_REF);
  if (!integHead) return { ok: false };
  const tmpBranch = `refs/heads/dcae-rebase-${taskId.toLowerCase()}-${Date.now()}`;
  git(kernel.opts.canonical, ['update-ref', tmpBranch, frozen]);
  const r = git(mergeDir, ['rebase', '--onto', integHead, `${frozen}~1`, tmpBranch.replace('refs/heads/', '')]);
  if (!r.ok) {
    git(mergeDir, ['rebase', '--abort']);
    git(kernel.opts.canonical, ['update-ref', '-d', tmpBranch]);
    return { ok: false };
  }
  const sha = currentSha(mergeDir, 'HEAD');
  git(mergeDir, ['update-ref', tmpBranch, sha ?? frozen]);
  git(kernel.opts.canonical, ['update-ref', '-d', tmpBranch]);
  return sha ? { ok: true, sha } : { ok: false };
}

/** 全局门禁（integration/重定基 sha 上；evidence kind: merge）。 */
async function runGlobalGates(kernel: Kernel, dir: string, taskId: string, commit: string): Promise<{ ok: boolean; signature?: string }> {
  const gates = loadGates(kernel.opts.canonical);
  if (!gates || gates.global.length === 0) return { ok: true };
  const store = new EvidenceStore(kernel.dcaeDir);
  const t = kernel.projection.task(taskId);
  for (const step of flattenPipelineSafe(gates.global)) {
    const def = gates.commands[step.cmd];
    if (!def) return { ok: false, signature: `missing-cmd:${step.cmd}` };
    const res = await kernel.host().exec([...def.argv], { cwd: dir, timeoutMs: 600_000, maxOutputBytes: gates.output_cap_kb * 1024 });
    const ok = res.exit === 0 && !res.timedOut;
    store.put({
      task: taskId, attempt: t.attempt, kind: 'merge', commit, base: '',
      run: { cmd: step.cmd, args: [] }, exit: res.exit ?? -1,
      result: ok ? 'pass' : res.timedOut ? 'timeout' : 'fail',
      startedAt: new Date().toISOString(), durationMs: res.durationMs,
      stdout: res.stdout, stderr: res.stderr, runner: gates.runner,
    });
    if (!ok) return { ok: false, signature: `global:${step.cmd}:exit${res.exit}` };
  }
  return { ok: true };
}

function flattenPipelineSafe(steps: import('../schema/gates.ts').GatesConfig['global']): { cmd: string; args: string[] }[] {
  const out: { cmd: string; args: string[] }[] = [];
  for (const s of steps) {
    if (typeof s === 'string') out.push({ cmd: s, args: [] });
    else if (Array.isArray(s)) for (const c of s) out.push({ cmd: c, args: [] });
    else out.push({ cmd: s.cmd, args: s.args });
  }
  return out;
}

/** dcae promote（人工执行）：重跑全局门禁后 fast-forward 主分支。 */
export async function promote(kernel: Kernel, mainBranch: string): Promise<{ ok: boolean; detail?: string }> {
  if (!kernel.lease.verify()) return { ok: false, detail: '租约验证失败' };
  const integ = revParse(kernel.opts.canonical, INTEGRATION_REF);
  if (!integ) return { ok: false, detail: 'integration ref 不存在' };
  const mergeDir = ensureMergeWorktree(kernel);
  if (!mergeDir) return { ok: false, detail: '合并工作树不可用' };
  const gates = await runGlobalGates(kernel, mergeDir, 'promote', integ);
  if (!gates.ok) return { ok: false, detail: `promote 前全局门禁失败：${gates.signature}` };
  const ff = git(kernel.opts.canonical, ['fetch', '.', `${INTEGRATION_REF}:${mainBranch}`]);
  if (!ff.ok) return { ok: false, detail: `fast-forward 失败：${ff.stderr.slice(0, 200)}` };
  return { ok: true };
}
