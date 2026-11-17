/**
 * 项目意图探测：判断当前 location 是否为 DCAE 项目。
 *
 * 全局安装的插件会在每个 location 执行 setup；因此不得按项目路径做 fail-closed 抛错。
 * 本模块只做无副作用的只读探测（不创建 .dcae、不建内核），供入口决定是否激活内核。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DcaeProjectDetection {
  isDcaeProject: boolean;
  /** 命中的信号（诊断/日志用）。 */
  signals: string[];
}

const AGENT_FILES = ['dcae-planner.md', 'dcae-dev.md', 'dcae-tester.md', 'dcae-reviewer.md'] as const;

/** 角色智能体齐备性检查（不做任何写入）。 */
export function agentsPresent(canonical: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const f of AGENT_FILES) {
    if (!existsSync(join(canonical, '.opencode', 'agents', f))) missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}

function hasDcaeConfigKey(canonical: string): boolean {
  for (const name of ['opencode.json', 'opencode.jsonc'] as const) {
    const p = join(canonical, name);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>;
      if (cfg && typeof cfg.dcae === 'object' && cfg.dcae !== null) return true;
    } catch {
      // jsonc 粗剥注释后重试
      try {
        const text = readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(text) as Record<string, unknown>;
        if (cfg && typeof cfg.dcae === 'object' && cfg.dcae !== null) return true;
      } catch { /* 尽力 */ }
    }
  }
  return false;
}

/**
 * 只读探测：任一信号命中即视为 DCAE 项目。
 * 信号：.dcae/ 状态目录、gates.yaml、tasks/*.yaml、opencode.json(c) 顶层 dcae 键、角色智能体文件。
 */
export function detectDcaeProject(canonical: string): DcaeProjectDetection {
  const signals: string[] = [];
  if (existsSync(join(canonical, '.dcae'))) signals.push('.dcae/');
  if (existsSync(join(canonical, 'gates.yaml'))) signals.push('gates.yaml');
  try {
    const tasks = readdirSync(join(canonical, 'tasks'));
    if (tasks.some((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) signals.push('tasks/*.yaml');
  } catch { /* 无 tasks 目录 */ }
  if (hasDcaeConfigKey(canonical)) signals.push('opencode.json#dcae');
  if (AGENT_FILES.some((f) => existsSync(join(canonical, '.opencode', 'agents', f)))) {
    signals.push('.opencode/agents/dcae-*.md');
  }
  return { isDcaeProject: signals.length > 0, signals };
}
