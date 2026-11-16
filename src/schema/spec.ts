/**
 * 规范 front-matter schema —— 1.4 §6.1（三种类型；approved 仅由人类设置）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common.ts';
import { parse as yamlParse } from 'yaml';
import { stripBom } from '../util/text.ts';

export const SpecTypeSchema = z.enum(['requirement', 'design', 'invariant']);
export const SpecStatusSchema = z.enum(['draft', 'approved', 'superseded']);

export const SpecFrontMatterSchema = z.strictObject({
  schema_version: SchemaVersion,
  id: z.string().regex(/^(SPEC|REQ|INV)-[A-Z0-9][A-Z0-9-]*$/),
  type: SpecTypeSchema,
  status: SpecStatusSchema,
  approved_by: z.string().optional(),
  approved_at: z.string().optional(),
  /** 仅有的手写边（1.4 §6.1）。 */
  refs: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
});
export type SpecFrontMatter = z.infer<typeof SpecFrontMatterSchema>;

/** 解析 Markdown + YAML front-matter 规范文件。 */
export function parseSpecFile(text: string): { front: SpecFrontMatter; body: string } | { errors: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { errors: ['缺少 front-matter'] };
  let raw: unknown;
  try {
    raw = yamlParse(stripBom(m[1]!));
  } catch (e) {
    return { errors: [`front-matter YAML 解析失败: ${String(e)}`] };
  }
  const r = SpecFrontMatterSchema.safeParse(raw);
  if (!r.success) return { errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { front: r.data, body: m[2] ?? '' };
}

/** 派生边类型（1.4 §6.1：refines / constrains / implements / verifies）。 */
export type DerivedEdgeKind = 'refines' | 'constrains' | 'implements' | 'verifies';
export interface DerivedEdge {
  kind: DerivedEdgeKind;
  from: string; // 代码文件 / check id / design spec id
  to: string; // spec id / requirement id
}
