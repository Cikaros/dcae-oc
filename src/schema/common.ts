/**
 * 通用 schema —— V2 权限规则（1.4 §2 #7 [D]：有序规则数组，三字符串字段）。
 * Permission.Ruleset.json / Rule：{action, resource, effect}，additionalProperties: false。
 */
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EffectSchema = z.enum(['allow', 'deny', 'ask']);
export type Effect = z.infer<typeof EffectSchema>;

/** V2 权限规则（会话/配置通用的有序数组元素）。 */
export const RuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string(),
  effect: EffectSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

/** YAML 文件通用头。 */
export const SchemaVersion = z.literal(1);

/** 内核插件配置（opencode.jsonc plugins 条目的 options；ctx.options 注入）。 */
export const KernelConfigSchema = z.object({
  /** RUNNING dev 任务并发上限（原则 10：默认 1，基准显示收益再放宽）。 */
  concurrency: z.number().int().positive().default(1),
  /** 同时进行的 TEST_WRITING 上限。 */
  testerConcurrency: z.number().int().positive().default(1),
  /** inbox 项默认 SLA 分钟。 */
  slaDefaultMinutes: z.number().int().positive().default(240),
  /** inbox 超时策略（1.4 §6.8）。 */
  inboxTimeoutPolicy: z.enum(['hold', 'fail-task']).default('hold'),
  /** saved approvals 周期复核分钟（决议 D-1 低频半边）。 */
  savedApprovalAuditMinutes: z.number().int().positive().default(30),
  /** tester 读规则 resource 提交形态（T-13 实测后收紧；默认双形态）。 */
  resourceForm: z.enum(['absolute', 'relative', 'both']).default('both'),
  /** 编译模式（T-8 语义漂移开关，1.4 §6.2）。 */
  compilerMode: z.enum(['star-crosses-slash', 'globstar']).default('star-crosses-slash'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** OpenCode 服务器 HTTP 基址（进程内插件访问 REST 兜底用；契约测试注入）。 */
  serverUrl: z.string().optional(),
  /** 内核自有会话的模型（`provider/id` 形态，如 scnet/DeepSeek-V4.1-Flash）；不设则用宿主默认。 */
  model: z.string().optional(),
});
export type KernelConfig = z.infer<typeof KernelConfigSchema>;

export const DEFAULT_CONFIG: KernelConfig = KernelConfigSchema.parse({});

/** 读目标项目 opencode(.json/.jsonc) 顶层 `dcae` 键（实测 ctx.options 不可用后的可靠通道）。 */
export function readProjectDcaeConfig(canonical: string): Partial<KernelConfig> | null {
  for (const name of ['opencode.json', 'opencode.jsonc'] as const) {
    const p = join(canonical, name);
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      if (cfg?.dcae && typeof cfg.dcae === 'object') return cfg.dcae as Partial<KernelConfig>;
      return null;
    } catch {
      try {
        const text = readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(text);
        if (cfg?.dcae && typeof cfg.dcae === 'object') return cfg.dcae as Partial<KernelConfig>;
      } catch { /* 尽力 */ }
    }
  }
  return null;
}
