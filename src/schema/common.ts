/**
 * 通用 schema —— V2 权限规则（1.4 §2 #7 [D]：有序规则数组，三字符串字段）。
 * Permission.Ruleset.json / Rule：{action, resource, effect}，additionalProperties: false。
 */
import { z } from 'zod';

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
});
export type KernelConfig = z.infer<typeof KernelConfigSchema>;

export const DEFAULT_CONFIG: KernelConfig = KernelConfigSchema.parse({});
