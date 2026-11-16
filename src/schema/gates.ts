/**
 * gates.yaml schema —— 1.4 §6.3（命令表、门禁管线、全局门禁、runner）。
 * 元字符禁令：argv 与 arg_globs 元素必须匹配 ^[A-Za-z0-9_./:*?=+-]+$（防回落 shell 的回归保护）。
 */
import { z } from 'zod';
import { SchemaVersion } from './common.ts';

/** 1.4 §6.3 逐字：禁 shell 元字符与空白。 */
export const ARG_ELEMENT_RE = /^[A-Za-z0-9_./:*?=+-]+$/;

const ArgElement = z.string().regex(ARG_ELEMENT_RE, '包含 shell 元字符或空白（1.4 §6.3 纵深防御）');

export const CommandDefSchema = z.strictObject({
  argv: z.array(ArgElement).min(1),
  arg_globs: z.array(ArgElement).optional(),
});
export type CommandDef = z.infer<typeof CommandDefSchema>;

const PipelineStepSchema = z.union([
  z.string(), // 单命令 id
  z.object({ cmd: z.string(), args: z.array(z.string()).default([]) }),
  z.array(z.string()), // 命令 id 列表（如 static: [typecheck, lint]）
]);

export const GatesSchema = z.strictObject({
  schema_version: SchemaVersion,
  runner: z.enum(['host', 'container']).default('host'),
  commands: z.record(z.string(), CommandDefSchema),
  pipeline: z.array(PipelineStepSchema).default([]),
  global: z.array(PipelineStepSchema).default([]),
  invariants_run: z.enum(['always', 'never']).default('always'),
  /** 一次性探针 argv[0] 白名单（人类所有；空 = 探针关闭，1.4 §6.3）。 */
  probe_argv0: z.array(z.string()).default([]),
  output_cap_kb: z.number().int().positive().default(256),
});
export type GatesConfig = z.infer<typeof GatesSchema>;

export function parseGates(text: string): { ok: true; gates: GatesConfig } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = yamlParse(text);
  } catch (e) {
    return { ok: false, errors: [`YAML 解析失败: ${String(e)}`] };
  }
  const r = GatesSchema.safeParse(raw);
  if (r.success) return { ok: true, gates: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

import { parse as yamlParse } from 'yaml';

/** 展开管线步骤为命令引用列表。 */
export function flattenPipeline(steps: z.infer<typeof PipelineStepSchema>[]): { cmd: string; args: string[] }[] {
  const out: { cmd: string; args: string[] }[] = [];
  for (const s of steps) {
    if (typeof s === 'string') out.push({ cmd: s, args: [] });
    else if (Array.isArray(s)) for (const c of s) out.push({ cmd: c, args: [] });
    else out.push({ cmd: s.cmd, args: s.args });
  }
  return out;
}
