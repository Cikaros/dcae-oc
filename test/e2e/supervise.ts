#!/usr/bin/env bun
/**
 * 监督者（评审资产）——bun test/e2e/supervise.ts <projDir> [TASK-ID...]
 * serve 假死（心跳龄 >60s）→ 重启；follower 接管修复自动恢复领导权与邮箱消费。
 * 终态：全部任务 MERGED/CANCELLED 或轮次耗尽。
 *
 * 安全说明：只终止本脚本 spawn 的 serve 子进程，不使用全局 `taskkill /IM`（避免误杀
 * 调用者所在的服务进程）。若需跨进程清理，请显式传入 DCAE_SUP_KILL_PID。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const proj = process.argv[2] ?? '';
if (!proj) { console.error('usage: bun test/e2e/supervise.ts <projDir> [TASK-ID...]'); process.exit(2); }
const PORT = Number(process.env.DCAE_SUP_PORT ?? '14948');
const MAX_ROUNDS = Number(process.env.DCAE_SUP_ROUNDS ?? '10');
const OPENCODE = process.env.DCAE_OPENCODE_BIN ?? 'opencode';
const ROOT = join(import.meta.dir, '..', '..');

/** 目标任务 ID：命令行显式给出，否则取 tasks/ 下全部任务定义。 */
const TASKS: string[] = process.argv.slice(3).length > 0
  ? process.argv.slice(3)
  : (() => {
      try {
        return readdirSync(join(proj, 'tasks'))
          .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
          .map((f) => f.replace(/\.ya?ml$/, ''));
      } catch { return []; }
    })();

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

/** 终态判定：全部目标任务均已 MERGED 或 CANCELLED。 */
function allTerminal(statusText: string): boolean {
  if (TASKS.length === 0) return false;
  return TASKS.every((id) => new RegExp(`${id}\\s+(MERGED|CANCELLED)`).test(statusText));
}

async function main(): Promise<number> {
  if (TASKS.length === 0) console.log('[sup] 未发现任务定义；仅做心跳与进程监督');
  let done = false;
  for (let round = 1; round <= MAX_ROUNDS && !done; round++) {
    await new Promise((r) => setTimeout(r, 1500));
    const logFile = join(process.env.TEMP ?? '/tmp', `dcae-sup-${round}.txt`);
    const child = spawn(OPENCODE, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
      cwd: proj, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killChild = (): void => {
      try { child.kill('SIGTERM'); } catch { /* 已退 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }, 2000);
    };
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
    if (!pw) {
      console.log(`[sup] round ${round}: 无密码输出，重启`);
      try { writeFileSync(logFile, serveText); } catch { /* 尽力 */ }
      killChild();
      continue;
    }
    const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
    const loc = encodeURIComponent(JSON.stringify({ directory: proj.replace(/\\/g, '/') }));
    console.log(`[sup] round ${round}: serve up (port ${PORT})`);
    // 激活（幂等；触发插件装载与内核接管）
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/plugin?location%5Bdirectory%5D=${loc}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
        const t = await r.text();
        if (t.includes('dcae')) { console.log(`[sup] round ${round}: dcae loaded`); break; }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    // 监控：心跳龄 >60s → 重启；全部终态 → 完成
    const deadline = Date.now() + 45 * 60_000;
    let last = '';
    let hung = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      const age = hbAgeS();
      const st = cli(['status', proj]);
      const line = st.split('\n').filter((l) => TASKS.some((id) => l.includes(id))).join(' | ').trim();
      const tag = age > 60 ? `[HANG ${age}s] ` : '';
      if (line !== last || age > 60) {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${tag}${line || '(no tasks)'}`);
        last = line;
      }
      if (age > 60) { hung = true; break; }
      if (allTerminal(st)) { done = true; break; }
    }
    killChild();
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
  const gitLog = spawnSync('git', ['-C', proj, 'log', '--oneline'], { encoding: 'utf8', timeout: 30_000 });
  console.log('=== git ===');
  console.log(gitLog.stdout ?? '');
  const refs = spawnSync('git', ['for-each-ref', 'refs/dcae', '--format=%(refname) %(objectname:short)'], { cwd: proj, encoding: 'utf8', timeout: 30_000 });
  console.log(refs.stdout ?? '');
  return done ? 0 : 1;
}

process.exitCode = await main();
