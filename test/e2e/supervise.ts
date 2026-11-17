#!/usr/bin/env bun
/**
 * 监督者（评审资产）——bun test/e2e/supervise.ts <projDir>
 * serve 假死（心跳龄 >60s）→ 杀掉重启；follower 接管修复自动恢复领导权与邮箱消费。
 * 终态：双 MERGED 或轮次耗尽。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const proj = process.argv[2] ?? '';
if (!proj) { console.error('usage: bun test/e2e/supervise.ts <projDir>'); process.exit(2); }
const PORT = 14948;
const MAX_ROUNDS = 10;
const ROOT = join(import.meta.dir, '..', '..');

function killServe(): void {
  try { spawnSync('taskkill', ['/F', '/IM', 'opencode.exe'], { timeout: 30_000 }); } catch { /* 无进程 */ }
}

function hbAgeS(): number {
  const f = join(proj, '.dcae', 'lock.json');
  if (!existsSync(f)) return 9999;
  try {
    const hb = (JSON.parse(readFileSync(f, 'utf8')) as { heartbeat_at: string }).heartbeat_at;
    return Math.round((Date.now() - Date.parse(hb)) / 1000);
  } catch { return 9999; }
}

function cli(args: string[]): string {
  const r = spawnSync('bun', [join(ROOT, 'src', 'cli.ts'), ...args], { cwd: proj, shell: false, encoding: 'utf8', timeout: 120_000 });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

async function main(): Promise<number> {
  let done = false;
  for (let round = 1; round <= MAX_ROUNDS && !done; round++) {
    killServe();
    await new Promise((r) => setTimeout(r, 1500));
    const out = join(process.env.TEMP ?? '/tmp', `wir-sup-${round}.txt`);
    const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
      cwd: proj, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serveText = '';
    child.stdout?.on('data', (d: Buffer) => { serveText += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { serveText += d.toString(); });
    let pw: string | null = null;
    const pwT0 = Date.now();
    while (!pw && Date.now() - pwT0 < 40_000) {
      const m = /server password (\S+)/.exec(serveText);
      if (m) { pw = m[1]!; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!pw) { console.log(`[sup] round ${round}: 无密码输出，重启`); killServe(); continue; }
    const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
    const headers = { authorization: auth.authorization };
    const loc = encodeURIComponent(JSON.stringify({ directory: proj.replace(/\\/g, '/') }));
    console.log(`[sup] round ${round}: serve up`);
    // 激活（幂等；触发插件装载与内核接管）
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/plugin?location%5Bdirectory%5D=${loc}`, { headers, signal: AbortSignal.timeout(20_000) });
        const t = await r.text();
        if (t.includes('dcae')) { console.log(`[sup] round ${round}: dcae loaded`); break; }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    // 监控：心跳龄 >60s → 重启；双 MERGED → 完成
    const deadline = Date.now() + 45 * 60_000;
    let last = '';
    let hung = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      const age = hbAgeS();
      const st = cli(['status', proj]);
      const line = st.split('\n').filter((l) => l.includes('T-WIR')).join(' | ').trim();
      const tag = age > 60 ? `[HANG ${age}s] ` : '';
      if (line !== last || age > 60) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag}${line || '(no tasks)'}`);
        last = line;
      }
      if (age > 60) { hung = true; break; }
      if (/T-WIR-001 MERGED/.test(line) && /T-WIR-002 MERGED/.test(line)) { done = true; break; }
    }
    if (done) break;
    if (!hung) console.log('[sup] 窗口内未推进（无假死）→ 照常重启换血');
  }
  console.log('=== final ===');
  console.log(cli(['status', proj]));
  const evFile = join(proj, '.dcae', 'state', 'events.jsonl');
  if (existsSync(evFile)) {
    console.log('=== events tail ===');
    for (const line of readFileSync(evFile, 'utf8').split('\n').filter(Boolean).slice(-16)) {
      console.log(line.slice(0, 225));
    }
  }
  const git = spawnSync('git', ['-C', proj, 'log', '--oneline'], { encoding: 'utf8', timeout: 30_000 });
  console.log('=== git ===');
  console.log(git.stdout ?? '');
  const refs = spawnSync('git', ['for-each-ref', 'refs/dcae', '--format=%(refname) %(objectname:short)'], { cwd: proj, encoding: 'utf8', timeout: 30_000 });
  console.log(refs.stdout ?? '');
  killServe();
  return done ? 0 : 1;
}

process.exitCode = await main();
