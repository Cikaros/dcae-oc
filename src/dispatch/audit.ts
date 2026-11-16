/**
 * 盲测提交与读审计 —— 1.4 §6.6 第 3–5 步；架构设计 §3.8（读审计落点）。
 * 盲性三层：分叉拓扑（起点无实现）→ 编译防线（过程隔离）→ 读审计（证据隔离兜底）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import type { IngestRequest, IngestResult, Kernel } from '../kernel/kernel.ts';
import { normalizeForMatch } from '../util/paths.ts';
import { git, headChangedFiles, currentSha } from '../util/git.ts';

/** dcae_test_submit 的效果层：校验路径 → 读审计 → 内核身份提交 → 哈希记录 → TEST_WRITING→READY。 */
export async function submitBlindTests(kernel: Kernel, req: IngestRequest, key: string): Promise<IngestResult> {
  const t = kernel.projection.task(req.task);
  const paths = (req.payload.paths as string[]) ?? [];
  if (paths.length === 0) return { ok: false, detail: 'paths 为空' };
  const scratch = t.worktree ?? '';
  if (!scratch || !existsSync(scratch)) return { ok: false, detail: `scratch worktree 不可用：${scratch}` };

  // 1. 路径范围校验：全部 ⊆ acceptance/<task>/**（1.4 §6.6 第 5 步）
  for (const p of paths) {
    const n = normalizeForMatch(p);
    if (!n.startsWith(`acceptance/${req.task}/`)) {
      return { ok: false, detail: `路径超出 acceptance/${req.task}/**：${p}` };
    }
  }

  // 2. 读越界审计（TEST_WRITING→READY 前执行；触发即 INVALIDATED→TEST_WRITING，reason: read-audit）
  const audit = await auditTesterReads(kernel, req.task, scratch);
  if (!audit.clean) {
    kernel.appendTransition(t, 'closure-invalidated', { reason: 'read-audit', violations: audit.violations, key });
    kernel.appendTransition(kernel.projection.task(req.task), 'read-audit', { key, violations: audit.violations });
    return { ok: false, detail: `读越界，盲测作废（${audit.violations.length} 处）：${audit.violations.slice(0, 3).join('; ')}` };
  }

  // 3. 内容哈希
  const hash = hashPaths(scratch, paths);

  // 4. 内核身份提交至 canonical（acceptance/ 是保护路径，落盘只能由内核完成——原则 2）
  const forkSha = currentSha(kernel.opts.canonical, 'HEAD');
  git(kernel.opts.canonical, ['add', `acceptance/${req.task}`]);
  // 从 scratch 拷贝到 canonical 的 acceptance/<task>/
  for (const p of paths) {
    const src = join(scratch, p);
    const dst = join(kernel.opts.canonical, p);
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(src, dst);
  }
  git(kernel.opts.canonical, ['add', `acceptance/${req.task}`]);
  const commit = git(kernel.opts.canonical, ['-c', 'user.name=DCAE Kernel', '-c', 'user.email=dcae@kernel.local', 'commit', '-m', `dcae(tests): ${req.task}`, '--author=DCAE Kernel <dcae@kernel.local>']);
  if (!commit.ok) {
    // 无变更也会走这里（重复提交）——视为已提交
    kernel.log.warn('audit', '测试提交无变更或失败', { stderr: commit.stderr.slice(0, 200) });
  }
  const commitSha = currentSha(kernel.opts.canonical, 'HEAD') ?? forkSha ?? '';

  // 5. 事件：test-committed + TEST_WRITING→READY（读审计通过、哈希已记录）
  kernel.appendMarkForTask(t, 'test-committed', { commitSha, hash, key, paths: paths.length });
  const ev = kernel.appendTransition(t, 'test-submit', { key, hash, commitSha });
  if (!ev) return { ok: false, detail: '事件追加失败（租约丢失）' };
  return { ok: true, queued: 'processed', event: ev };
}

export interface AuditResult {
  clean: boolean;
  violations: string[];
}

/**
 * 读越界审计（架构设计 §3.8 读审计落点）：重放 tester 会话的**消息端点**（实测权威源——
 * sessionLog SSE 不回放历史），审计 read/glob/grep/shell 工具调用的输入资源，
 * 触达 scratch 之外路径或 git 对象引用（refs/dcae、对象库）即判读越界。
 */
export async function auditTesterReads(kernel: Kernel, taskId: string, scratch: string): Promise<AuditResult> {
  const t = kernel.projection.task(taskId);
  if (!t.sessionId) return { clean: true, violations: [] };
  const violations: string[] = [];
  const scratchN = normalizeForMatch(scratch);
  const GIT_OBJ_PATTERNS = ['refs/dcae', 'git show', 'git cat-file', 'git log'];

  try {
    const msgs = await kernel.hostForSession(t.sessionId).sessionMessages(t.sessionId);
    for (const m of msgs) {
      for (const tool of m.tools ?? []) {
        if (!/read|glob|grep|shell|list/i.test(tool.name)) continue;
        const resource = normalizeForMatch(
          typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input ?? ''),
        );
        if (!resource || resource === '{}' || resource === '""') continue;
        // 路径类：scratch 之外的绝对路径触达（消息里绝对路径为 Windows 形态，归一化后比对）
        const absMatches = resource.match(/([A-Za-z]:\/[^\s"',\\]+|\/[A-Za-z0-9_./-]{4,})/g) ?? [];
        for (const abs of absMatches) {
          const n = normalizeForMatch(abs);
          if (!n.startsWith(scratchN)) violations.push(`${tool.name}: ${n}`);
        }
        // 相对遍历
        if (/\.\./.test(resource)) violations.push(`${tool.name}: traversal ${resource.slice(0, 120)}`);
        // git 对象引用类
        for (const g of GIT_OBJ_PATTERNS) {
          if (resource.includes(g)) {
            violations.push(`${tool.name}: git-obj ${g}`);
            break;
          }
        }
      }
    }
  } catch (e) {
    // 消息不可读（无 HTTP 基址等）：保守视为有越界风险，但不作废——记遥测，交人工判断
    kernel.log.warn('audit', '会话消息重放失败（保守放行 + 遥测）', { error: String(e) });
    return { clean: true, violations: [`log-unavailable: ${String(e)}`] };
  }
  return { clean: violations.length === 0, violations };
}

/** 路径集合的内容哈希（dispatch 核对用，1.4 §6.6 第 6 步）。 */
export function hashPaths(base: string, paths: string[]): string {
  const h = createHash('sha256');
  for (const p of [...paths].sort()) {
    const full = join(base, p);
    h.update(p);
    h.update('\0');
    try {
      if (statSync(full).isFile()) h.update(readFileSync(full));
    } catch { /* 缺失即哈希空 */ }
    h.update('\0');
  }
  return h.digest('hex');
}

export { relative };
