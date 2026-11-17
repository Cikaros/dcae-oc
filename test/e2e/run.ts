#!/usr/bin/env bun
/**
 * 全链 e2e 驱动（评审资产）——bun test/e2e/run.ts [--port N] [--proj DIR] [--timeout-min 40]
 * 流程：全新 fixture（initProject + 版本化资产 + git）→ plan-approve（邮箱）→ opencode serve
 * → 激活（loaded 信号）→ 轮询状态至 MERGED/CANCELLED/超时（FAILED 自动 retry ≤2 次）
 * → 终态 dump（事件/inbox/src/git/refs）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { initProject, pluginRoot } from '../../src/init/init.ts';
import { enqueue } from '../../src/kernel/mailbox.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return (i >= 0 ? process.argv[i + 1] : fallback) ?? fallback;
}

const ROOT = pluginRoot();
const FX = join(ROOT, 'test', 'fixtures', 'e2e');
const PORT = Number(arg('--port', '14970'));
const TEMP = process.env.TEMP ?? '/tmp';
const PROJ = arg('--proj', join(TEMP, 'dcae-e2e-proj'));
const DEADLINE_MIN = Number(arg('--timeout-min', '40'));
const PKG_REF = arg('--plugin', join(TEMP, 'dcae-e2e-install', 'node_modules', 'dcae-oc').replace(/\\/g, '/'));
const MODEL = arg('--model', 'scnet/DeepSeek-V4.1-Flash');

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, shell: false, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function cli(args: string[]): string {
  const r = spawnSync('bun', [join(ROOT, 'src', 'cli.ts'), ...args], { shell: false, encoding: 'utf8', timeout: 120_000 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      try {
        if (readdirSync(p)) walk(p);
      } catch {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

async function main(): Promise<number> {
  // 0. 清旧目录
  //    注意：不使用全局 `taskkill /IM opencode.exe`——那会误杀调用者所在的服务进程。
  //    本驱动只终止自己 spawn 的 serve 子进程（见下方 child.kill）。
  rmSync(PROJ, { recursive: true, force: true });
  mkdirSync(PROJ, { recursive: true });

  // 1. init（安装后包引用 + model）——硬断言
  const ir = initProject(PROJ, { pluginRef: PKG_REF, testRunner: 'bun', model: MODEL });
  console.log('[init] written:', ir.written.length, 'skipped:', ir.skipped.length);
  if (!existsSync(join(PROJ, 'opencode.json'))) throw new Error('FATAL: init 未写 opencode.json');
  if (!readFileSync(join(PROJ, 'opencode.json'), 'utf8').includes(`"model": "${MODEL}"`)) throw new Error('FATAL: dcae.model 缺失');

  // 2. fixture 资产 + git
  mkdirSync(join(PROJ, 'specs'), { recursive: true });
  mkdirSync(join(PROJ, 'src'), { recursive: true });
  cpSync(join(FX, 'SPEC-DEMO.md'), join(PROJ, 'specs', 'SPEC-DEMO.md'));
  cpSync(join(FX, 'T-DEMO-001.yaml'), join(PROJ, 'tasks', 'T-DEMO-001.yaml'));
  cpSync(join(FX, 'hello.test.ts'), join(PROJ, 'src', 'hello.test.ts'));
  cpSync(join(FX, 'gates.yaml'), join(PROJ, 'gates.yaml'));
  git(PROJ, ['init', '-b', 'main']);
  git(PROJ, ['add', '-A']);
  git(PROJ, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  console.log('[fixture] ready:', PROJ);

  // 3. plan-approve（决策邮箱）
  enqueue(join(PROJ, '.dcae'), 'decision', `plan-approve:T-DEMO-001:${Date.now()}`, {
    action: 'plan-approve', tasks: ['T-DEMO-001'], by: 'e2e-driver',
  });
  console.log('[mailbox] plan-approve enqueued');

  // 4. serve + 密码
  const serveOut: string[] = [];
  const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
    cwd: PROJ,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => serveOut.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => serveOut.push(d.toString()));
  const base = `http://127.0.0.1:${PORT}`;
  const pwReady = await waitFor(() => /server password (\S+)/.test(serveOut.join('')), 60_000, 1500);
  if (!pwReady) throw new Error('FATAL: serve 无密码输出\n' + serveOut.join('').slice(-800));
  const pw = /server password (\S+)/.exec(serveOut.join(''))![1]!;
  const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
  console.log('[serve] up at', base);

  // 5. 激活（loaded 信号：/api/plugin 含 dcae）
  let loaded = false;
  for (let i = 1; i <= 20; i++) {
    try {
      const res = await fetch(`${base}/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(PROJ)}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      if (text.includes('dcae')) { loaded = true; console.log(`[activate] dcae loaded (attempt ${i})`); break; }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!loaded) throw new Error('FATAL: 插件未装载\n' + serveOut.join('').slice(-800));

  // 6. 轮询至终态（FAILED 自动 retry ≤2）
  const deadline = Date.now() + DEADLINE_MIN * 60_000;
  let lastLine = '';
  let retries = 0;
  let finalState = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20_000));
    const st = cli(['status', PROJ]);
    const line = st.split('\n').find((l) => l.includes('T-DEMO'))?.trim() ?? '';
    if (line && line !== lastLine) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); lastLine = line; }
    if (/MERGED|CANCELLED/.test(line)) { finalState = line; break; }
    if (/FAILED/.test(line) && retries < 2) {
      retries++;
      console.log(`[driver] FAILED → retry #${retries}`);
      cli(['retry', 'T-DEMO-001', PROJ]);
    }
    if (/BLOCKED/.test(line)) { finalState = line; break; }
  }
  if (!finalState) finalState = lastLine || 'TIMEOUT';

  // 7. 终态 dump
  console.log('=== final status ===');
  console.log(cli(['status', PROJ]));
  const evFile = join(PROJ, '.dcae', 'state', 'events.jsonl');
  console.log('=== events ===');
  if (existsSync(evFile)) {
    for (const line of readFileSync(evFile, 'utf8').split('\n').filter(Boolean)) {
      console.log(line.slice(0, 235));
    }
  }
  console.log('=== inbox ===');
  console.log(cli(['inbox', 'list', PROJ]));
  console.log('=== src ===');
  for (const f of listFiles(join(PROJ, 'src'))) console.log(f.replace(PROJ, ''));
  console.log('=== git ===');
  console.log(git(PROJ, ['log', '--oneline']).out);
  console.log(git(PROJ, ['for-each-ref', 'refs/dcae', '--format=%(refname) %(objectname:short)']).out);
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  try { child.kill('SIGKILL'); } catch { /* 已退 */ }
  console.log(`=== RESULT: ${finalState} (retries=${retries}) ===`);
  return /MERGED/.test(finalState) ? 0 : 1;
}

process.exitCode = await main();
