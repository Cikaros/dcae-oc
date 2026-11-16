/**
 * 任务定义 schema —— 1.4 §6.2（逐字字段；未知字段拒绝）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common.ts';

export const TaskRoleSchema = z.enum(['planner', 'tester', 'dev', 'reviewer']);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const CheckSchema = z.object({
  id: z.string().min(1),
  run: z.object({ cmd: z.string().min(1), args: z.array(z.string()).default([]) }),
  covers: z.array(z.string()).default([]),
  timeout_s: z.number().int().positive().default(120),
});
export type Check = z.infer<typeof CheckSchema>;

export const BudgetSchema = z.object({
  attempts: z.number().int().positive().default(3),
  tokens: z.number().int().positive().default(400000),
  minutes: z.number().int().positive().default(30),
  review_cycles: z.number().int().nonnegative().default(1),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** DCAE glob：* 不跨 /，** 跨，? 单字符，X/** 含 X 自身（1.4 §6.2）。 */
const GlobArray = z.array(z.string().min(1));

export const TaskSchema = z.strictObject({
  schema_version: SchemaVersion,
  id: z.string().regex(/^T-[A-Z0-9][A-Z0-9-]*$/),
  objective: z.string().min(1),
  spec_refs: z.array(z.string()).default([]),
  deps: z.array(z.string()).default([]),
  role: TaskRoleSchema.default('dev'),
  scope: z.strictObject({
    write: GlobArray.default([]),
    /** 引用 gates.yaml 命令 id，不是命令行字符串（1.4 §6.2）。 */
    shell: z.array(z.string()).default([]),
  }),
  blind_tests: z.boolean().default(false),
  blind_test: z.object({ attempts: z.number().int().positive(), minutes: z.number().int().positive() }).optional(),
  acceptance_tests: z.array(z.string()).default([]),
  checks: z.array(CheckSchema).default([]),
  invariants: z.array(z.string()).default([]),
  budget: BudgetSchema.default({ attempts: 3, tokens: 400000, minutes: 30, review_cycles: 1 }),
  /** 外部只读加白（架构设计 §8.4：仅在 inbox 决策应用后注入）。 */
  external_read_allow: z.array(z.string()).default([]),
});
export type TaskDef = z.infer<typeof TaskSchema>;

/** 校验任务并返回结构化错误。 */
export function parseTask(text: string): { ok: true; task: TaskDef } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    // YAML 文件允许 front-matter 或整文件 YAML；此处输入为去掉 --- 围栏后的 YAML 文本
    raw = requireYaml(text);
  } catch (e) {
    return { ok: false, errors: [`YAML 解析失败: ${String(e)}`] };
  }
  const r = TaskSchema.safeParse(raw);
  if (r.success) return { ok: true, task: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

import { parse as yamlParse } from 'yaml';
function requireYaml(text: string): unknown {
  const stripped = text.replace(/^---\s*\n/, '').replace(/\n---\s*$/, '');
  return yamlParse(stripped);
}

/** 保护路径（原则 2 对象；PolicyCompiler deny 与范围检查共用）。 */
export const PROTECTED_PATHS = [
  'specs/**', 'specs/drafts/**', 'gates.yaml', 'acceptance/**', 'tasks/**', 'dcp/**',
  'invariants/**', '.dcae/**', 'AGENTS.md', 'opencode.jsonc', 'opencode.json',
] as const;
