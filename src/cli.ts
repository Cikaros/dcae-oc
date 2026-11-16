#!/usr/bin/env bun
/**
 * dcae CLI —— 决策与查询的薄命令面（1.4 §6.8；决策经 decision 邮箱，权威且重启安全）。
 * 命令：init / validate / status / verify / inbox list|decide|sync / retry / revalidate / promote / approve-spec / clean
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { enqueue } from './kernel/mailbox.ts';
import { loadAllTaskDefs } from './tasks/load.ts';
import { parseGates } from './schema/gates.ts';
import { parseInboxItem } from './schema/inbox.ts';
import { dcaeGlobMatch } from './util/glob.ts';
import { PROTECTED_PATHS } from './schema/task.ts';
import { initProject } from './init/init.ts';
import { readJsonl } from './util/jsonl.ts';
import { Projection } from './kernel/state.ts';
import { git } from './util/git.ts';

const HELP = `dcae — DCAE-OC 命令面
  dcae init [dir] [--runner <bin>] [--plugin <ref>]    目标项目脚手架
  dcae validate [dir]                                   任务/门禁静态校验
  dcae status [dir]                                     任务状态投影
  dcae verify [dir]                                     无状态只读核查（CI 可用）
  dcae inbox list [dir]                                 收件箱清单
  dcae decide <INBOX-ID> --option <id> [--note "..."]    决策（经邮箱，≤5s 生效）
  dcae inbox sync [dir]                                 手改 YAML 后重写邮箱
  dcae retry <TASK> [dir]                               FAILED→READY（新 attempt）
  dcae revalidate <TASK> [dir]                          INVALIDATED→TEST_WRITING
  dcae promote [dir] [--branch main]                    integration→主分支（人工）
  dcae approve-spec <SPEC-ID> [dir]                     写 status: approved
  dcae plan-approve <TASK> [<TASK>...] [dir]            批准计划（任务进入 PENDING 起点）
  dcae clean [dir]                                      孤儿 worktree 清理（dry-run 先行）`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function detectRoot(args: string[]): string {
  // 先剔除选项与其值（--runner bun / --plugin ref），再取第一个存在目录的位置参数
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) { i++; continue; } // 跳过旗标与其值
    if (a.startsWith('-')) continue;
    clean.push(a);
  }
  const reserved = new Set(['init', 'validate', 'status', 'verify', 'inbox', 'list', 'decide', 'sync', 'retry', 'revalidate', 'promote', 'approve-spec', 'clean']);
  for (const a of clean) {
    if (reserved.has(a)) continue;
    const c = resolve(a);
    if (existsSync(c)) return c;
  }
  return process.cwd();
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const root = detectRoot(argv.slice(1));
  const dcaeDir = join(root, '.dcae');

  switch (cmd) {
    case 'init': {
      const r = initProject(root, {
        testRunner: arg(argv, '--runner'),
        pluginRef: arg(argv, '--plugin'),
        model: arg(argv, '--model'),
      });
      console.log('已写入:', r.written.join(', ') || '（无）');
      if (r.skipped.length > 0) console.log('已跳过（存在）:', r.skipped.join(', '));
      return 0;
    }
    case 'validate':
      return validate(root);
    case 'status':
      return status(root, dcaeDir);
    case 'verify':
      return verify(root);
    case 'inbox': {
      const sub = argv[1];
      if (sub === 'list') return inboxList(dcaeDir);
      if (sub === 'sync') return inboxSync(dcaeDir);
      console.error(HELP);
      return 2;
    }
    case 'decide': {
      const id = argv[1];
      const option = arg(argv, '--option');
      const note = arg(argv, '--note');
      if (!id || !option) {
        console.error('用法：dcae decide <INBOX-ID> --option <id> [--note "..."]');
        return 2;
      }
      enqueue(dcaeDir, 'decision', id, { option, note, by: process.env.USERNAME ?? process.env.USER ?? 'human' });
      console.log(`决策已入队：${id} -> ${option}（≤5s 生效）`);
      return 0;
    }
    case 'retry': {
      const task = argv[1];
      if (!task) return usage('retry <TASK>');
      enqueue(dcaeDir, 'decision', `retry:${task}:${Date.now()}`, { action: 'retry', task });
      console.log(`retry 已入队：${task}`);
      return 0;
    }
    case 'revalidate': {
      const task = argv[1];
      if (!task) return usage('revalidate <TASK>');
      enqueue(dcaeDir, 'decision', `revalidate:${task}:${Date.now()}`, { action: 'revalidate', task });
      console.log(`revalidate 已入队：${task}`);
      return 0;
    }
    case 'promote': {
      const branch = arg(argv, '--branch') ?? 'main';
      enqueue(dcaeDir, 'decision', `promote:${branch}:${Date.now()}`, { action: 'promote', branch });
      console.log(`promote 已入队（${branch}）：持有者将重跑全局门禁后 fast-forward`);
      return 0;
    }
    case 'approve-spec': {
      const spec = argv[1];
      if (!spec) return usage('approve-spec <SPEC-ID>');
      enqueue(dcaeDir, 'decision', `approve-spec:${spec}:${Date.now()}`, { action: 'approve-spec', spec, by: process.env.USERNAME ?? 'human' });
      console.log(`approve-spec 已入队：${spec}`);
      return 0;
    }
    case 'plan-approve': {
      // 人工批准计划：任务进入 PENDING 起点（幂等；leader 心跳 ≤5s 消费）
      // 任务 ID = 非旗标位置参数中除去目录（detectRoot 结果）的部分
      const rootPath = resolve(root);
      const taskList = argv.slice(1).filter((a) => !a.startsWith('-') && resolve(a) !== rootPath);
      if (taskList.length === 0) return usage('plan-approve <TASK> [<TASK>...] [dir]');
      enqueue(dcaeDir, 'decision', `plan-approve:${taskList.join('+')}:${Date.now()}`, { action: 'plan-approve', tasks: taskList, by: process.env.USERNAME ?? 'human' });
      console.log(`plan-approve 已入队：${taskList.join(', ')}`);
      return 0;
    }
    case 'clean': {
      const r = git(root, ['worktree', 'list', '--porcelain']);
      const wts = r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
      const orphans = wts.filter((w) => /[/\\]dcae-/.test(w) && !w.startsWith(root));
      console.log('孤儿 worktree：', orphans.length > 0 ? orphans.join('\n  ') : '（无）');
      console.log('（移除请手动运行：git worktree remove <dir>；内核不越权删除非本进程产物）');
      return 0;
    }
    default:
      console.log(HELP);
      return cmd ? 2 : 0;
  }
}

function usage(s: string): number {
  console.error(`用法：dcae ${s}`);
  return 2;
}

/** dcae validate（1.4 §6.2 规则）。 */
function validate(root: string): number {
  const errors: string[] = [];
  const gatesR = parseGates(existsSync(join(root, 'gates.yaml')) ? readFileSync(join(root, 'gates.yaml'), 'utf8') : '{}');
  let gates: import('./schema/gates.ts').GatesConfig | null = null;
  if (gatesR.ok) gates = gatesR.gates;
  else errors.push(...gatesR.errors.map((e) => `gates.yaml: ${e}`));
  const defs = loadAllTaskDefs(join(root, 'tasks'));
  if (defs.length === 0) console.log('（tasks/ 无任务）');
  const written: string[] = [];
  for (const def of defs) {
    // checks.run 引用 gates 命令 id + args 匹配 arg_globs
    for (const c of def.checks) {
      const g = gates?.commands[c.run.cmd];
      if (!g) errors.push(`${def.id}: checks.${c.id}.run.cmd 未定义于 gates.yaml：${c.run.cmd}`);
      else {
        for (const a of c.run.args) {
          if (a.includes('*') || a.includes('?')) continue; // glob 形态由内核展开
          if (g.arg_globs && !g.arg_globs.some((pat) => dcaeGlobMatch(pat, a))) {
            errors.push(`${def.id}: checks.${c.id}.run.args "${a}" 不匹配 ${c.run.cmd} 的 arg_globs`);
          }
        }
      }
    }
    // scope.write 不与保护路径重叠
    for (const w of def.scope.write) {
      for (const p of PROTECTED_PATHS) {
        if (overlap(w, p)) errors.push(`${def.id}: scope.write "${w}" 与保护路径 "${p}" 重叠`);
      }
    }
    // 并行写范围不重叠（按 deps 无序的兄弟任务近似：与所有其他任务比较，仅当存在共同并行窗口——保守报告全部相交）
    for (const other of defs) {
      if (other.id === def.id || other.deps.includes(def.id) || def.deps.includes(other.id)) continue;
      for (const w of def.scope.write) {
        for (const v of other.scope.write) {
          if (overlap(w, v)) errors.push(`${def.id} 与 ${other.id}: 并行写范围可能重叠（"${w}" vs "${v}"）`);
        }
      }
    }
    // 引用规范必须 approved（drafts 不合格）
    void written;
    // DAG 无环
    if (hasCycle(defs)) errors.push('任务 DAG 存在环');
  }
  if (errors.length > 0) {
    console.error(`validate 失败（${errors.length}）：`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`validate 通过（${defs.length} 个任务）`);
  return 0;
}

function overlap(a: string, b: string): boolean {
  // DCAE glob 语义的相交性保守判定：任一模式可匹配对方的前缀样本
  return dcaeGlobMatch(a, b.replace(/\*\*/g, 'x').replace(/\*/g, 'x')) || dcaeGlobMatch(b, a.replace(/\*\*/g, 'x').replace(/\*/g, 'x')) || a === b;
}

function hasCycle(defs: ReturnType<typeof loadAllTaskDefs>): boolean {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  let cycle = false;
  const visit = (id: string): void => {
    if (done.has(id) || cycle) return;
    if (visiting.has(id)) {
      cycle = true;
      return;
    }
    visiting.add(id);
    for (const d of byId.get(id)?.deps ?? []) visit(d);
    visiting.delete(id);
    done.add(id);
  };
  for (const d of defs) visit(d.id);
  return cycle;
}

/** 离线投影装载（不经租约/内核）。 */
function loadProjection(dcaeDir: string): Projection {
  const p = new Projection();
  const snap = join(dcaeDir, 'state', 'snapshot.json');
  if (existsSync(snap)) {
    try {
      p.loadSnapshot(JSON.parse(readFileSync(snap, 'utf8')));
    } catch { /* 全量重放 */ }
  }
  const events = readJsonl<{ seq: number }>(join(dcaeDir, 'state', 'events.jsonl'));
  for (const e of events as never[]) {
    (p as unknown as { apply(e: never): void }).apply(e);
  }
  return p;
}

function status(root: string, dcaeDir: string): number {
  const p = loadProjection(dcaeDir);
  if (p.tasks.size === 0) {
    console.log('（无任务状态——先由人类批准计划或经内核 plan-approved）');
    return 0;
  }
  const staleInbox = listInboxStale(dcaeDir);
  for (const s of staleInbox) console.log(`[STALE] ${s}`);
  for (const t of [...p.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`${t.id.padEnd(20)} ${t.state.padEnd(12)} attempt=${t.attempt} ${t.blockedReason ?? ''}`);
  }
  return 0;
}

function listInboxStale(dcaeDir: string): string[] {
  const dir = join(dcaeDir, 'inbox');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /^INBOX-\d+\.yaml$/.test(x))) {
    const r = parseInboxItem(readFileSync(join(dir, f), 'utf8'));
    if (!r.ok) continue;
    const it = r.item;
    if (it.status === 'open' && Date.now() - Date.parse(it.created_at) > 8 * it.sla_minutes * 60_000) {
      out.push(`${it.id}（8×SLA 超时）`);
    }
  }
  return out;
}

function inboxList(dcaeDir: string): number {
  const dir = join(dcaeDir, 'inbox');
  if (!existsSync(dir)) {
    console.log('（收件箱为空）');
    return 0;
  }
  for (const f of readdirSync(dir).filter((x) => /^INBOX-\d+\.yaml$/.test(x)).sort()) {
    const r = parseInboxItem(readFileSync(join(dir, f), 'utf8'));
    if (!r.ok) continue;
    const it = r.item;
    console.log(`${it.id} [${it.status}] ${it.kind} ${it.ref.task ?? ''}\n  ${it.question}\n  选项: ${it.options.map((o) => o.id).join(' / ')}`);
  }
  return 0;
}

/** inbox sync：手改 YAML 后重写邮箱（sync 只重写邮箱，1.4 §6.8）。 */
function inboxSync(dcaeDir: string): number {
  const dir = join(dcaeDir, 'inbox');
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /^INBOX-\d+\.yaml$/.test(x))) {
    const r = parseInboxItem(readFileSync(join(dir, f), 'utf8'));
    if (!r.ok || r.item.status !== 'decided' || !r.item.decision) continue;
    enqueue(dcaeDir, 'decision', r.item.id, { option: r.item.decision.option, note: r.item.decision.note, by: 'human-sync' });
    n++;
  }
  console.log(`sync 已重写 ${n} 个决策邮箱信封`);
  return 0;
}

/** dcae verify：无状态只读核查（CI 不需要状态库，只读 Git，1.4 §6.5）。 */
function verify(root: string): number {
  const problems: string[] = [];
  // integration 与已接受冻结 ref 可达性
  const integ = git(root, ['rev-parse', '--verify', 'refs/dcae/integration']);
  if (integ.ok) {
    const accepted = git(root, ['for-each-ref', 'refs/dcae/accepted/', '--format=%(refname)']);
    for (const ref of accepted.stdout.split('\n').filter(Boolean)) {
      const merged = git(root, ['merge-base', '--is-ancestor', ref.trim(), 'refs/dcae/integration']);
      if (!merged.ok) problems.push(`${ref.trim()} 尚未合并进 integration`);
    }
  }
  if (problems.length > 0) {
    console.log(`verify 发现 ${problems.length} 项：`);
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  console.log('verify 通过（只读核查无异常）');
  return 0;
}

await main();
