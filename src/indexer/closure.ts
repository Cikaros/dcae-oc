/**
 * Indexer —— 派生边表与任务闭包（1.4 §6.1/§7.3；架构设计 §3.13）。
 * 派生边：refines（design→requirement）/ constrains（invariant→spec）/ implements（@spec 标注）/ verifies（@covers 标注）。
 * 反向边表：spec → 闭包包含它的任务（增量失效用）；闭包哈希在 dispatch 时记入事件。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseSpecFile, type DerivedEdge, type DerivedEdgeKind } from '../schema/spec.ts';
import { loadAllTaskDefs } from '../tasks/load.ts';
import type { TaskDef } from '../schema/task.ts';

export interface SpecIndex {
  id: string;
  type: string;
  status: string;
  file: string;
  refs: string[];
  hash: string;
}

export interface ProjectIndex {
  specs: Map<string, SpecIndex>;
  /** 派生边表。 */
  edges: DerivedEdge[];
  /** 反向边表：spec id → 任务 id。 */
  reverse: Map<string, string[]>;
  builtAt: string;
}

export function buildIndex(canonical: string): ProjectIndex {
  const specs = new Map<string, SpecIndex>();
  const edges: DerivedEdge[] = [];
  // 1. 规范 front-matter（specs/ 递归，含 drafts）
  for (const file of walkFiles(join(canonical, 'specs'), '.md')) {
    const r = parseSpecFile(readFileSync(file, 'utf8'));
    if ('errors' in r) continue;
    specs.set(r.front.id, {
      id: r.front.id,
      type: r.front.type,
      status: r.front.status,
      file: file.replace(/\\/g, '/'),
      refs: r.front.refs,
      hash: sha(r.front.id + r.front.status + r.front.refs.join(',') + r.body),
    });
    for (const to of r.front.refs) {
      edges.push({ kind: r.front.type === 'design' ? 'refines' : 'constrains', from: r.front.id, to });
    }
  }
  // 2. 代码标注（@spec ID / @covers ID；限文本文件）
  for (const ext of ['.ts', '.tsx', '.js', '.py', '.go', '.rs', '.java']) {
    for (const file of walkFiles(join(canonical, 'src'), ext, 8)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/@spec\s+([A-Z][A-Z0-9-]+)/g)) {
        edges.push({ kind: 'implements', from: file.replace(/\\/g, '/'), to: m[1]! });
      }
      for (const m of text.matchAll(/@covers\s+([A-Z][A-Z0-9-]+)/g)) {
        edges.push({ kind: 'verifies', from: file.replace(/\\/g, '/'), to: m[1]! });
      }
    }
  }
  const idx: ProjectIndex = { specs, edges, reverse: new Map(), builtAt: new Date().toISOString() };
  // 3. 任务闭包与反向边表
  for (const def of loadAllTaskDefs(join(canonical, 'tasks'))) {
    const closure = taskClosure(canonical, def, idx);
    for (const specId of closure.specs) {
      const arr = idx.reverse.get(specId) ?? [];
      arr.push(def.id);
      idx.reverse.set(specId, arr);
    }
  }
  return idx;
}

export interface TaskClosure {
  /** 闭包内全部规范（传递依赖 + checks 覆盖 + 绑定不变量对应的 spec）。 */
  specs: Set<string>;
  /** 保护路径引用（验收测试 + gates.yaml）。 */
  protectedPaths: Set<string>;
  hash: string;
}

/** 任务闭包 = 传递依赖闭包中全部规范、契约与保护路径的内容哈希集合（1.4 §7.3）。 */
export function taskClosure(canonical: string, def: TaskDef, idx: ProjectIndex): TaskClosure {
  const specs = new Set<string>();
  const paths = new Set<string>();
  const visit = (taskId: string, seen = new Set<string>()): void => {
    if (seen.has(taskId)) return;
    seen.add(taskId);
    const d = taskId === def.id ? def : loadAllTaskDefs(join(canonical, 'tasks')).find((x) => x.id === taskId);
    if (!d) return;
    for (const s of d.spec_refs) {
      specs.add(s);
      const sp = idx.specs.get(s);
      if (sp) for (const up of sp.refs) specs.add(up); // refines 传递
    }
    for (const c of d.checks) for (const cov of c.covers) specs.add(cov);
    for (const inv of d.invariants) specs.add(inv);
    for (const a of d.acceptance_tests) paths.add(a);
    for (const dep of d.deps) visit(dep, seen);
  };
  visit(def.id);
  paths.add('gates.yaml');
  const hashParts: string[] = [];
  for (const s of [...specs].sort()) hashParts.push(s + ':' + (idx.specs.get(s)?.hash ?? 'missing'));
  for (const p of [...paths].sort()) hashParts.push(p);
  return { specs, protectedPaths: paths, hash: sha(hashParts.join('|')) };
}

/** 增量失效：规范/契约变更 → 反向边表命中任务（1.4 §7.3：反向遍历，不是全图扫描）。 */
export function affectedTasks(idx: ProjectIndex, changedSpecIds: string[]): string[] {
  const out = new Set<string>();
  for (const id of changedSpecIds) {
    for (const t of idx.reverse.get(id) ?? []) out.add(t);
  }
  return [...out];
}

function walkFiles(dir: string, ext: string, depth = 6): string[] {
  const out: string[] = [];
  if (depth < 0 || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, ext, depth - 1));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
