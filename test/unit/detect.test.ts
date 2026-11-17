import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { detectDcaeProject, agentsPresent } from '../../src/init/detect.ts';
import { initProject, pluginRoot } from '../../src/init/init.ts';

const TMP = join(import.meta.dir, '.tmp-detect');
function fresh(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  return TMP;
}
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('DCAE 项目意图探测（只读、无副作用）', () => {
  beforeEach(() => fresh());

  test('空目录 → 非 DCAE 项目', () => {
    const d = detectDcaeProject(TMP);
    expect(d.isDcaeProject).toBe(false);
    expect(d.signals).toEqual([]);
  });

  test('普通项目（opencode.json 无 dcae 键）→ 非 DCAE 项目', () => {
    writeFileSync(join(TMP, 'opencode.json'), JSON.stringify({ model: 'x/y' }));
    expect(detectDcaeProject(TMP).isDcaeProject).toBe(false);
  });

  test('opencode.json 顶层含 dcae 键 → DCAE 项目', () => {
    writeFileSync(join(TMP, 'opencode.json'), JSON.stringify({ dcae: { model: 'x/y' } }));
    const d = detectDcaeProject(TMP);
    expect(d.isDcaeProject).toBe(true);
    expect(d.signals).toContain('opencode.json#dcae');
  });

  test('gates.yaml / tasks/*.yaml / .dcae 各自可命中', () => {
    writeFileSync(join(TMP, 'gates.yaml'), 'schema_version: 1\n');
    expect(detectDcaeProject(TMP).signals).toContain('gates.yaml');
    rmSync(join(TMP, 'gates.yaml'));
    mkdirSync(join(TMP, 'tasks'), { recursive: true });
    writeFileSync(join(TMP, 'tasks', 'T-1.yaml'), 'id: T-1\n');
    expect(detectDcaeProject(TMP).signals).toContain('tasks/*.yaml');
    rmSync(join(TMP, 'tasks'), { recursive: true, force: true });
    mkdirSync(join(TMP, '.dcae'), { recursive: true });
    expect(detectDcaeProject(TMP).signals).toContain('.dcae/');
  });

  test('探测不产生副作用（不创建 .dcae）', () => {
    detectDcaeProject(TMP);
    expect(require('node:fs').existsSync(join(TMP, '.dcae'))).toBe(false);
  });

  test('init 后 → DCAE 项目且角色智能体齐备', () => {
    initProject(TMP, { pluginRef: 'dcae-oc', model: 'x/y' });
    expect(detectDcaeProject(TMP).isDcaeProject).toBe(true);
    expect(agentsPresent(TMP).ok).toBe(true);
  });

  test('只缺 agents 时 agentsPresent 报告缺失且不抛错', () => {
    writeFileSync(join(TMP, 'gates.yaml'), 'schema_version: 1\n');
    const r = agentsPresent(TMP);
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBe(4);
  });

  test('initProject(pluginRef:null, model:null) → 空 plugins 与空 dcae', () => {
    initProject(TMP, { pluginRef: null, model: null });
    const cfg = JSON.parse(require('node:fs').readFileSync(join(TMP, 'opencode.json'), 'utf8'));
    expect(cfg.plugins).toEqual([]);
    expect(cfg.dcae).toEqual({});
  });

  test('pluginRoot 指向仓库根且模板存在', () => {
    const root = pluginRoot();
    expect(require('node:fs').existsSync(join(root, 'templates', 'opencode.jsonc'))).toBe(true);
  });
});
