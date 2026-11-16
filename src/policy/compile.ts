/**
 * PolicyCompiler —— 任务+角色 → V2 会话权限规则（1.4 §6.2/§6.6；架构设计 §8）。
 * 产物定位：跨目录逃逸与跨范围写入的粗防线——deny 精确、allow 偏宽；
 * 单段约束的唯一权威保证是事后 diff 与保护哈希（1.4 §6.2 编译的预防强度上限）。
 * 产物只含 allow/deny，不制造 ask（无人值守 ask 由 evaluate 钩子兜底，架构设计 §8.4）。
 */
import type { Rule } from '../host/port.ts';
import type { TaskDef } from '../schema/task.ts';
import { PROTECTED_PATHS } from '../schema/task.ts';
import { dcaeGlobToPlatform, isSingleSegment } from './translate.ts';
import { absolutize, joinPosix, normalizeForMatch, toPosix } from '../util/paths.ts';
import type { KernelConfig } from '../schema/common.ts';

export type Role = 'planner' | 'tester' | 'dev' | 'reviewer';

export interface CompileEnv {
  canonicalDir: string;
  worktreeDir: string;
  /** 全部已知项目 worktree 目录（tester 读 deny 用）。 */
  allWorktreeDirs?: string[];
  /** gates 命令表（scope.shell 的命令 id → argv[0..] 前缀）。 */
  commandPrefixes?: Record<string, string[]>;
  config?: Partial<KernelConfig>;
  /** 已批准的外部只读加白（决策应用后注入；架构设计 §8.4）。 */
  externalReadAllow?: string[];
}

export interface CompileReport {
  rules: Rule[];
  telemetry: { singleSegmentScope: string[]; untranslatable: string[] };
}

const deny = (action: string, resource = '*'): Rule => ({ action, resource, effect: 'deny' });
const allow = (action: string, resource: string): Rule => ({ action, resource, effect: 'allow' });

export function compile(task: TaskDef, role: Role, env: CompileEnv): CompileReport {
  const telemetry = { singleSegmentScope: [] as string[], untranslatable: [] as string[] };
  const rules: Rule[] = [];
  const cfg = { resourceForm: 'both' as const, ...env.config };

  // ---- 全角色公共：子代理 + external_directory（对抗平台默认 allow，1.4 §6.2 P0） ----
  if (role === 'planner') {
    // 1.4 §5.5：planner 仅 explore 子代理
    rules.push(deny('subagent'), allow('subagent', 'explore'));
  } else {
    rules.push(deny('subagent'));
  }
  rules.push(deny('external_directory'));
  for (const p of env.externalReadAllow ?? []) {
    rules.push(allow('read', normalizeForMatch(p)));
  }

  // ---- 写面 ----
  rules.push(deny('edit'));
  if (role === 'dev') {
    for (const g of task.scope.write) {
      if (isSingleSegment(g)) telemetry.singleSegmentScope.push(g); // 单段：不编译为 allow，交事后 diff（架构设计 §8.2）
      const translated = dcaeGlobToPlatform(g, cfg as KernelConfig);
      if (translated === null) {
        telemetry.untranslatable.push(g);
        continue;
      }
      rules.push(allow('edit', translated));
    }
  } else if (role === 'tester') {
    // 只可写 scratch 内 acceptance/<task>/**（1.4 §6.6 第 3 步）
    const acc = `acceptance/${task.id}/**`;
    const translated = dcaeGlobToPlatform(acc, cfg as KernelConfig);
    if (translated) rules.push(allow('edit', translated));
  } else if (role === 'planner') {
    // specs/drafts、tasks（1.4 §5.5 可编辑列）
    for (const g of ['specs/drafts/**', 'tasks/**']) {
      const translated = dcaeGlobToPlatform(g, cfg as KernelConfig);
      if (translated) rules.push(allow('edit', translated));
    }
  }
  // reviewer：零写（1.4 §5.5 可编辑=无）

  // ---- tester 读隔离双编译（1.4 §6.6 第 3 步；防线 a 主防线 + 防线 b 项目外） ----
  if (role === 'tester') {
    const scratch = normalizeForMatch(env.worktreeDir);
    const targets: string[] = [normalizeForMatch(env.canonicalDir)];
    for (const w of env.allWorktreeDirs ?? []) {
      const n = normalizeForMatch(w);
      if (n !== scratch) targets.push(n);
    }
    targets.push(joinPosix(normalizeForMatch(env.canonicalDir), '.dcae'));
    // resource 提交形态开关（T-13 实测后收紧；默认双形态）
    const forms: ('absolute' | 'relative')[] =
      cfg.resourceForm === 'both' ? ['absolute', 'relative'] : [cfg.resourceForm];
    for (const action of ['read', 'glob', 'grep'] as const) {
      for (const target of targets) {
        if (cfg.resourceForm === 'absolute' || cfg.resourceForm === 'both') {
          rules.push(deny(action, `${absolutize(target, '/') === target ? target : target}/*`));
        }
        if (cfg.resourceForm === 'relative' || cfg.resourceForm === 'both') {
          // 会话相对形态（T-iso 决定哪个生效；双形态保守同发）
          rules.push(deny(action, `${relFrom(scratch, target)}/*`));
        }
      }
      rules.push(deny(action, '*..*')); // 相对遍历兜底（平台 * 跨 / 使其合法）
    }
    // 注意：scratch 内 read 保持默认 allow——不得为 tester 编译 read deny-all（1.4 §6.6 第 3 步）
  }

  // ---- shell：deny 全部 + allow 白名单前缀（last-match 使窄 allow 后置生效，1.4 §6.3） ----
  rules.push(deny('shell'));
  if (role === 'dev' || role === 'tester') {
    for (const cmdId of task.scope.shell) {
      const prefix = env.commandPrefixes?.[cmdId];
      if (!prefix || prefix.length === 0) {
        telemetry.untranslatable.push(`shell:${cmdId}`);
        continue;
      }
      // 前缀模式带尾 " *" 同时匹配无参数形式（1.4 §6.2 [D]）
      rules.push(allow('shell', prefix.join(' ') + ' *'));
    }
  }
  // planner/reviewer：无 shell（1.4 §5.5）

  // ---- 保护路径 edit deny（冗余于 edit deny-all，显式保留供审计可读，架构设计 §8.3） ----
  for (const p of PROTECTED_PATHS) {
    const translated = dcaeGlobToPlatform(p, cfg as KernelConfig);
    if (translated) rules.push(deny('edit', translated));
  }

  return { rules, telemetry };
}

/** 相对形态：从 scratch 到目标的相对路径（`..` 出 scratch）。 */
function relFrom(from: string, to: string): string {
  const f = from.split('/').filter(Boolean);
  const t = to.split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const ups = f.length - i;
  const downs = t.slice(i);
  if (ups === 0) return downs.join('/');
  return [...Array(ups).fill('..'), ...downs].join('/');
}

/** 绝对模式辅助（供契约测试与调用方复用）。 */
export function absolutePattern(dir: string): string {
  return `${normalizeForMatch(toPosix(dir).replace(/\/$/, ''))}/*`;
}
