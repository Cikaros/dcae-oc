/**
 * GateRunner —— 在 worktree 中运行门禁（1.4 §6.3；架构设计 §9）。
 * 无 shell：HostPort.exec(argv) 直接 spawn；匹配发生在 argv 空间；
 * glob 由内核展开（展开为空即校验失败，不执行）；
 * 元字符元素被 schema 与运行期双重拒绝（CI 契约："元字符参数必须被拒"）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Kernel } from '../kernel/kernel.ts';
import { parseGates, flattenPipeline, ARG_ELEMENT_RE, type GatesConfig } from '../schema/gates.ts';
import { expandGlob, dcaeGlobMatch } from '../util/glob.ts';
import { normalizeForMatch } from '../util/paths.ts';
import { sha256 } from '../evidence/store.ts';
import { EvidenceStore } from '../evidence/store.ts';

export interface GateOutcome {
  pass: boolean;
  evidenceIds: string[];
  signature?: string;
  failedChecks: string[];
  scopeViolations: string[];
  protectedViolations: string[];
}

/** 装载并解析 gates.yaml（内核级缓存无需——人类所有，变更经重新读取）。 */
export function loadGates(canonical: string): GatesConfig | null {
  for (const name of ['gates.yaml', 'gates.yml'] as const) {
    const p = join(canonical, name);
    if (!existsSync(p)) continue;
    const r = parseGates(readFileSync(p, 'utf8'));
    return r.ok ? r.gates : null;
  }
  return null;
}

/** 展开单个门禁步骤为具体 argv（校验失败 → {ok:false}）。 */
export function buildStepArgv(gates: GatesConfig, step: { cmd: string; args: string[] }, cwd: string): { ok: true; argv: string[] } | { ok: false; detail: string } {
  const def = gates.commands[step.cmd];
  if (!def) return { ok: false, detail: `命令 id 未定义于 gates.yaml：${step.cmd}` };
  const argv = [...def.argv];
  for (const a of def.argv) {
    if (!ARG_ELEMENT_RE.test(a)) return { ok: false, detail: `argv 元素含元字符：${a}` };
  }
  for (const arg of step.args) {
    if (!ARG_ELEMENT_RE.test(arg)) return { ok: false, detail: `参数含元字符：${arg}` };
    if (arg.includes('*') || arg.includes('?')) {
      // glob：内核展开为具体路径，每个路径一个 argv 元素（1.4 §6.3）
      const expanded = expandGlob(arg, cwd);
      if (expanded.length === 0) return { ok: false, detail: `glob 展开为空：${arg}` };
      argv.push(...expanded);
    } else {
      // 字面量：必须匹配该命令的某条 arg_globs（DCAE glob 语义）
      if (def.arg_globs && def.arg_globs.length > 0) {
        if (!def.arg_globs.some((g) => dcaeGlobMatch(g, arg))) {
          return { ok: false, detail: `参数不匹配 arg_globs：${arg}（命令 ${step.cmd}）` };
        }
      }
      argv.push(arg);
    }
  }
  return { ok: true, argv };
}

/** 门禁管线执行（VERIFYING 效果层；结果为 gate-pass / gate-fail / gate-exhausted）。 */
export async function runGatePipeline(kernel: Kernel, taskId: string, attempt: number): Promise<GateOutcome> {
  const t = kernel.projection.task(taskId);
  const def = kernel.taskDef(taskId);
  const gates = loadGates(kernel.opts.canonical);
  const worktree = t.worktree ?? kernel.opts.canonical;
  const base = kernel.opts.canonical;
  const store = new EvidenceStore(kernel.dcaeDir);
  const outcome: GateOutcome = {
    pass: false,
    evidenceIds: [],
    failedChecks: [],
    scopeViolations: [],
    protectedViolations: [],
  };
  if (!gates) {
    kernel.appendTransition(t, 'gate-exhausted', { error: 'gates.yaml 缺失或非法' });
    return { ...outcome, signature: sha256('gates-missing') };
  }
  if (!def) {
    kernel.appendTransition(t, 'gate-exhausted', { error: `任务定义缺失：${taskId}` });
    return { ...outcome, signature: sha256('task-missing') };
  }

  // 内核自动提交 dev worktree 的未提交改动（冻结 ref 需要committed内容，1.4 §6.7；
  // dev 只写不提交——提交是内核产出的证据，author = kernel 身份）。
  // 归属校验：show-toplevel 必须等于 worktree 根——防误提交宿主仓（unit 测试临时目录在父仓内）。
  try {
    const { git } = await import('../util/git.ts');
    const top = git(worktree, ['rev-parse', '--show-toplevel']);
    const topN = top.ok ? top.stdout.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
    const wtN = worktree.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (topN !== wtN) {
      kernel.log.debug('gates', 'worktree 非 git 根（跳过自动提交）', { worktree, top: topN });
    } else {
      const st = git(worktree, ['status', '--porcelain']);
      if (st.ok && st.stdout.trim() !== '') {
        // 依赖树排除（双保险：模板已发 .gitignore，此处仍强制排除——防人类项目漏配）
        git(worktree, ['add', '-A', '--', ':/', ':(exclude)node_modules', ':(exclude)node_modules/**']);
        git(worktree, ['-c', 'user.name=DCAE Kernel', '-c', 'user.email=dcae@kernel.local', 'commit', '-m', `dcae(dev): ${taskId} attempt ${attempt}`]);
        kernel.log.info('gates', 'dev 改动已由内核提交', { taskId, worktree });
      }
    }
  } catch (e) {
    kernel.log.warn('gates', '自动提交失败（门禁继续）', { taskId, error: String(e) });
  }

  const headSha = kernel.host().appVersion() ? await getHead(kernel, worktree) : null;
  const started = Date.now();
  const steps = [...flattenPipeline(gates.pipeline), ...def.checks.map((c) => ({ cmd: c.run.cmd, args: c.run.args }))];
  let failed: string[] = [];
  const signatures: string[] = [];

  for (const step of steps) {
    const argvR = buildStepArgv(gates, step, worktree);
    if (!argvR.ok) {
      failed.push(`${step.cmd}: ${argvR.detail}`);
      signatures.push(sha256(`${step.cmd}|${argvR.detail}`));
      continue;
    }
    const res = await kernel.host().exec(argvR.argv, {
      cwd: worktree,
      timeoutMs: (def.checks.find((c) => c.run.cmd === step.cmd)?.timeout_s ?? 120) * 1000,
      maxOutputBytes: gates.output_cap_kb * 1024,
    });
    const result: 'pass' | 'fail' | 'error' | 'timeout' = res.timedOut
      ? 'timeout'
      : res.exit === 0
        ? 'pass'
        : res.exit === null
          ? 'error'
          : 'fail';
    const ev = store.put({
      task: taskId,
      attempt,
      kind: 'check',
      commit: headSha ?? '',
      base,
      run: { cmd: step.cmd, args: step.args },
      exit: res.exit ?? -1,
      result,
      startedAt: new Date(started).toISOString(),
      durationMs: res.durationMs,
      stdout: res.stdout,
      stderr: res.stderr,
      runner: gates.runner,
    });
    outcome.evidenceIds.push(ev.record.id);
    kernel.appendMarkForTask(t, 'evidence-recorded', { evId: ev.record.id, kind: 'check', result });
    if (result !== 'pass') {
      failed.push(`${step.cmd}（exit=${res.exit}${result === 'timeout' ? ', 超时' : ''}）`);
      signatures.push(signatureOf(step.cmd, res.stderr.length > 0 ? res.stderr : res.stdout));
    }
  }

  // 不变量（invariants_run: always → 门禁尾跑，1.4 §6.3）
  if (gates.invariants_run === 'always' && def.invariants.length > 0) {
    for (const invId of def.invariants) {
      const invCmd = loadInvariantCommand(kernel.opts.canonical, invId);
      if (!invCmd) {
        failed.push(`不变量 ${invId} 缺少绑定命令`);
        signatures.push(sha256(`invariant|${invId}|missing`));
        continue;
      }
      const argvR = buildStepArgv(gates, { cmd: invCmd.cmd, args: invCmd.args }, worktree);
      if (!argvR.ok) {
        failed.push(`不变量 ${invId}: ${argvR.detail}`);
        continue;
      }
      const res = await kernel.host().exec(argvR.argv, { cwd: worktree, timeoutMs: 120_000, maxOutputBytes: gates.output_cap_kb * 1024 });
      const ok = res.exit === 0;
      const ev = store.put({
        task: taskId, attempt, kind: 'invariant', commit: headSha ?? '', base,
        run: { cmd: invCmd.cmd, args: invCmd.args }, exit: res.exit ?? -1,
        result: ok ? 'pass' : 'fail', startedAt: new Date(started).toISOString(), durationMs: res.durationMs,
        stdout: res.stdout, stderr: res.stderr, runner: gates.runner,
      });
      outcome.evidenceIds.push(ev.record.id);
      if (!ok) failed.push(`不变量 ${invId} 失败`);
    }
  }

  // 范围检查与保护哈希（1.4 §7.1 VERIFYING→REVIEW 守卫）。
  // lockfile 排除：依赖锁文件是 install 白名单命令的必然副产物（dev 无法控制其生成），
  // 强制入范围会让任何含 install 的任务不可能通过——按"内核产出命令的副产品"豁免。
  const LOCKFILES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'yarn.lock']);
  const forkSha = getForkSha(kernel, taskId);
  if (forkSha && headSha) {
    const { headChangedFiles } = await import('../util/git.ts');
    const changed = headChangedFiles(kernel.opts.canonical, forkSha, headSha);
    for (const f of changed) {
      const n = normalizeForMatch(f);
      if (LOCKFILES.has(n.split('/').pop() ?? n)) continue;
      if (def.scope.write.some((g) => dcaeGlobMatch(g, n))) continue;
      outcome.scopeViolations.push(n);
    }
  }

  outcome.failedChecks = failed;
  outcome.signature = signatures.length > 0 ? signatures[0] : undefined;

  if (failed.length === 0 && outcome.scopeViolations.length === 0) {
    kernel.appendTransition(t, 'gate-pass', { evidenceIds: outcome.evidenceIds });
    outcome.pass = true;
    return outcome;
  }

  // 门禁失败 → attempts 剩余且签名未重复 → VERIFYING→RUNNING；否则 FAILED
  const signatureNew = !t.gateFailSignatures.includes(outcome.signature ?? '');
  const g = kernel.guard(t, 'gate-fail', { kind: 'submit', task: taskId, session: t.sessionId ?? '', payload: { signature: outcome.signature ?? '' } } as never);
  if (g.ok && signatureNew && t.attempt < (def.budget.attempts ?? 3) - 0) {
    kernel.appendTransition(t, 'gate-fail', { signature: outcome.signature, failedChecks: failed, scopeViolations: outcome.scopeViolations, evidenceIds: outcome.evidenceIds });
    // 回 RUNNING：注入失败详情（dev 必须知道修什么——通用提醒不含范围违规信息，实测教训）
    if (t.sessionId) {
      const detail = [
        failed.length > 0 ? `门禁失败：${failed.join('；')}` : '',
        outcome.scopeViolations.length > 0 ? `范围外写入：${outcome.scopeViolations.join(', ')}（只可写 ${def.scope.write.join(', ')}）` : '',
      ].filter(Boolean).join('\n');
    try {
      // fire-and-forget（prompt 挂起不得堵死门禁效果层——30s 护栏在 HostPort.prompt 内）
      void kernel.hostForSession(t.sessionId).prompt(t.sessionId, `门禁未通过（不消耗 attempt）：\n${detail}\n修正后重新 dcae_submit。`, { messageId: `msg_${Date.now().toString(36)}gf`, delivery: 'queue' }).catch(() => { });
    } catch { /* 会话由等待器/提醒兜底 */ }
    }
    return outcome;
  }
  kernel.appendTransition(t, 'gate-exhausted', { signature: outcome.signature, failedChecks: failed, scopeViolations: outcome.scopeViolations, evidenceIds: outcome.evidenceIds });
  return outcome;
}

function signatureOf(cmd: string, output: Buffer): string {
  const text = output.toString('utf8', 0, 2048); // 失败输出首 2 KiB（架构设计 §9.1）
  const normalized = text.replace(/\r\n/g, '\n').replace(/at .+:\d+:\d+/g, 'at <frame>');
  return sha256(`${cmd}|${normalized}`);
}

async function getHead(kernel: Kernel, worktree: string): Promise<string | null> {
  const { currentSha } = await import('../util/git.ts');
  return currentSha(worktree);
}

function getForkSha(kernel: Kernel, taskId: string): string | null {
  for (const e of kernel.eventLog.all()) {
    if (e.task === taskId && e.reason === 'dispatch') {
      const d = (e.data ?? {}) as any;
      if (typeof d?.forkSha === 'string') return d.forkSha;
    }
  }
  return null;
}

function loadInvariantCommand(canonical: string, invId: string): { cmd: string; args: string[] } | null {
  try {
    const dir = join(canonical, 'invariants');
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const raw = parse(readFileSync(join(dir, f), 'utf8')) as any;
      if (raw?.id === invId && raw?.run?.cmd) {
        return { cmd: String(raw.run.cmd), args: (raw.run.args as string[]) ?? [] };
      }
    }
  } catch { /* 尽力 */ }
  return null;
}
