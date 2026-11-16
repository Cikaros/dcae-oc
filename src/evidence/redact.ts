/**
 * 脱敏 —— 密钥永不写入；哈希前先跑脱敏模式（1.4 §6.4）。
 */
const PATTERNS: RegExp[] = [
  /(?:sk|pk)-[A-Za-z0-9_-]{16,}/g, // OpenAI/Stripe 形态
  /ghp_[A-Za-z0-9]{30,}/g, // GitHub PAT
  /gho_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS AK
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(?:api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[=:]\s*\S+/gi, // 键值对
];

/** 命中即替换 [REDACTED]（架构设计 §9.2）。 */
export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}
