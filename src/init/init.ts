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
  /** 插件引用形态：本地目录绝对路径（默认）或包名；显式 null = 不写 plugins 条目（依赖全局安装）。 */
  pluginRef?: string | null;
  /** 测试运行器（gates.yaml 的 argv[0]）。 */
  testRunner?: string;
  /** 内核会话模型（`provider/id`）；显式 null = 不写（用宿主默认模型）。 */
  model?: string | null;
  dryRun?: boolean;
}

export function initProject(target: string, opts: InitOptions = {}): { written: string[]; skipped: string[] } {
  const root = pluginRoot();
  const written: string[] = [];
  const skipped: string[] = [];
  const pluginRef = opts.pluginRef === undefined ? root : opts.pluginRef;
  const runner = opts.testRunner ?? 'bun';
  const model = opts.model === undefined ? 'scnet/DeepSeek-V4.1-Flash' : opts.model;

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

  // 2. opencode.json（纯 JSON——jsonc 中文注释在本平台解析失败；插件引用 + dcae.model + 权限规则数组）
  //    pluginRef/model 为 null 时对应条目留空/省略（全局安装场景不重复声明 plugins）。
  const tpl = readFileSync(join(root, 'templates', 'opencode.jsonc'), 'utf8');
  const pluginsBlock = pluginRef === null ? '"plugins": []' : `"plugins": [\n    ${JSON.stringify(pluginRef)}\n  ]`;
  const dcaeBlock = model === null ? '"dcae": {}' : `"dcae": {\n    "model": ${JSON.stringify(model)}\n  }`;
  const rendered = tpl
    .replace(/"plugins":\s*\[\s*\{\{PLUGIN_REF\}\}\s*\]/, pluginsBlock)
    .replace(/"dcae":\s*\{\s*"model":\s*\{\{DCAE_MODEL\}\}\s*\}/, dcaeBlock);
  put('opencode.json', rendered);

  // 3. gates.yaml（人类所有）
  put('gates.yaml', readFileSync(join(root, 'templates', 'gates.yaml'), 'utf8').replaceAll('{{TEST_RUNNER}}', runner));

  // 3.5 .gitignore（实测教训：dev 的 bun install 生成 node_modules，无 ignore 会被内核自动
  //     提交裹进 diff → 范围违规循环）
  put('.gitignore', readFileSync(join(root, 'templates', 'gitignore'), 'utf8'));

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

/** 插件启动校验用：目标项目智能体文件齐备性（实现见 init/detect.ts，单一定义）。 */
export { agentsPresent } from './detect.ts';
