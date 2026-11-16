/**
 * dcae init —— 目标项目脚手架（1.4 §5.6 仓库布局落地）。
 * 写入：.opencode/agents/dcae-*.md、opencode.jsonc（插件+permissions）、AGENTS.md 协议块、
 * gates.yaml、目录骨架（specs/drafts、invariants、acceptance、tasks、dcp）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pluginRoot(): string {
  // 本模块位于 src/init/init.ts；agents/ 与 templates/ 在仓库根
  const here = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  return here.split('/src/init/')[0]!;
}

export interface InitOptions {
  /** 插件引用形态：本地目录绝对路径（默认）或 npm 包名。 */
  pluginRef?: string;
  /** 测试运行器（gates.yaml 的 argv[0]）。 */
  testRunner?: string;
  dryRun?: boolean;
}

export function initProject(target: string, opts: InitOptions = {}): { written: string[]; skipped: string[] } {
  const root = pluginRoot();
  const written: string[] = [];
  const skipped: string[] = [];
  const pluginRef = opts.pluginRef ?? root;
  const runner = opts.testRunner ?? 'bun';

  const put = (rel: string, content: string): void => {
    const p = join(target, rel);
    if (existsSync(p)) {
      skipped.push(rel);
      return;
    }
    if (opts.dryRun) {
      written.push(rel);
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    written.push(rel);
  };

  // 1. 角色智能体（V2 合法字段；permissions 显式声明——未声明按 deny-all [C]）
  for (const f of ['dcae-planner.md', 'dcae-dev.md', 'dcae-tester.md', 'dcae-reviewer.md'] as const) {
    const src = join(root, 'agents', f);
    const rel = join('.opencode', 'agents', f).replace(/\\/g, '/');
    const dst = join(target, rel);
    if (existsSync(dst)) {
      skipped.push(rel);
    } else if (!opts.dryRun) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      written.push(rel);
    }
  }

  // 2. opencode.json（纯 JSON：实测本平台 jsonc 中文注释解析失败——2026-11-16 M0 实测；
  //    插件引用 + V2 有序权限规则数组）
  const tpl = readFileSync(join(root, 'templates', 'opencode.jsonc'), 'utf8');
  put('opencode.json', tpl.replace('{{PLUGIN_REF}}', JSON.stringify(pluginRef)));

  // 3. gates.yaml（人类所有）
  put('gates.yaml', readFileSync(join(root, 'templates', 'gates.yaml'), 'utf8').replaceAll('{{TEST_RUNNER}}', runner));

  // 4. AGENTS.md 协议块（V2 只认 AGENTS.md，不回退 CLAUDE.md [D]；人类所有文件，只追加生成块）
  const agentsPath = join(target, 'AGENTS.md');
  const block = readFileSync(join(root, 'templates', 'AGENTS.block.md'), 'utf8');
  if (!existsSync(agentsPath)) {
    if (!opts.dryRun) {
      mkdirSync(target, { recursive: true });
      writeFileSync(agentsPath, '# AGENTS.md\n\n' + block);
      written.push('AGENTS.md');
    }
  } else if (!readFileSync(agentsPath, 'utf8').includes('DCAE 协议')) {
    if (!opts.dryRun) {
      appendFileSync(agentsPath, '\n' + block);
      written.push('AGENTS.md (+block)');
    }
  } else {
    skipped.push('AGENTS.md');
  }

  // 5. 目录骨架
  for (const d of ['specs/drafts', 'invariants', 'acceptance', 'tasks', 'dcp']) {
    const rel = `${d}/.gitkeep`;
    put(rel, '');
  }

  return { written, skipped };
}

/** 插件启动校验用：目标项目智能体文件齐备性。 */
export function agentsPresent(target: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const f of ['dcae-planner.md', 'dcae-dev.md', 'dcae-tester.md', 'dcae-reviewer.md'] as const) {
    if (!existsSync(join(target, '.opencode', 'agents', f))) missing.push(f);
  }
  return { ok: missing.length === 0, missing };
}
