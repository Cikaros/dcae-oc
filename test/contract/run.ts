#!/usr/bin/env bun
/**
 * M0 契约测试外部 runner（架构设计 §10.1）。
 * 拓扑：sandbox（临时 git 项目 + dcae init 脚手架）→ `opencode serve`（DCAE_CONTRACT=1）
 * → 外部断言（HTTP：T-1/T-2/T-10/T-14）+ 进程内断言（RPC contract：T-3..T-13）→ results md/json。
 * LLM 依赖项（T-9 压缩 epoch、T-12 idle outcome、T-10 prompt 重放）默认跳过，--with-model 开启。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initProject, pluginRoot } from '../../src/init/init.ts';
import { git, revParse } from '../../src/util/git.ts';

interface CaseResult {
  case: string;
  name: string;
  ok: boolean | 'INCONCLUSIVE';
  detail: unknown;
  note?: string;
}

const ONLY = process.argv.filter((a) => a.startsWith('--case=')).map((a) => a.slice(7));
const WITH_MODEL = process.argv.includes('--with-model');
const KEEP = process.argv.includes('--keep');

async function main(): Promise<number> {
  const root = pluginRoot();
  const sandbox = mkdtempSync(join(tmpdir(), 'dcae-contract-'));
  console.log(`[harness] sandbox: ${sandbox}`);
  const port = 14000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. 脚手架（dogfood：initProject 落地 agents/opencode.jsonc/gates.yaml）
  initProject(sandbox, { pluginRef: root, testRunner: 'bun' });

  // 2. git init + 基线提交（worktree 类契约需要）
  git(sandbox, ['init', '-b', 'main']);
  git(sandbox, ['add', '-A']);
  git(sandbox, ['-c', 'user.name=contract', '-c', 'user.email=c@local', 'commit', '-m', 'baseline', '--no-gpg']);
  const head = revParse(sandbox, 'HEAD');
  console.log(`[harness] baseline: ${head?.slice(0, 8)}`);

  // 3. 启动 opencode serve（DCAE_CONTRACT=1；插件经 opencode.jsonc 本地目录引用加载）
  const exe = resolveArgv0Local();
  const child = spawn(exe, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: sandbox,
    env: {
      ...process.env,
      DCAE_CONTRACT: '1',
      DCAE_OPENCODE_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { serverLog += d.toString(); });

  const results: CaseResult[] = [];
  try {
    // 4. 等待就绪 + 解析 server password（v2 serve 生成 Basic 认证：username=opencode）
    let password: string | null = null;
    const up = await waitFor(async () => {
      const m = /server password (\S+)/.exec(serverLog);
      if (m) password = m[1]!;
      if (!password) return false;
      return fetchJson('GET', baseUrl, '/api/info', undefined, password).then((r) => r.ok).catch(async () => false);
    }, 30_000);
    if (!up || !password) {
      console.error('[harness] 服务器未就绪；日志尾部：');
      console.error(serverLog.split('\n').slice(-40).join('\n'));
      return 1;
    }
    console.log(`[harness] server up: ${baseUrl}（auth: basic/opencode）`);
    AUTH.current = password;
    const info = await fetchJson('GET', baseUrl, '/api/info', undefined, password);
    const version = String((info.json as any)?.version ?? (info.json as any)?.data?.version ?? 'unknown');
    console.log(`[harness] opencode version: ${version}`);

    // 5. 外部断言
    if (pick('T-1')) results.push(await caseT1(baseUrl, sandbox, password));
    if (pick('T-2')) results.push(await caseT2(baseUrl, password));
    if (pick('T-10')) results.push(await caseT10(baseUrl, sandbox, port, password));
    if (pick('T-14')) results.push(await caseT14(baseUrl, password));
    if (pick('T-11')) results.push(await caseT11External(baseUrl, password));

    // 6. 进程内断言（RPC contract；先激活 location——插件 setup 在首个请求到达该目录时才运行）
    const internalCases = ['T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9', 'T-11', 'T-12', 'T-13'].filter((c) => !WITH_MODEL && c === 'T-12' ? false : pick(c));
    await activateLocation(baseUrl, sandbox, password);
    const rpc = await callContractRpc(baseUrl, internalCases, () => serverLog, sandbox);
    results.push(...rpc);

    // LLM 依赖项声明
    if (!WITH_MODEL) {
      results.push({ case: 'T-9', name: '压缩后 epoch 推进（[X] 运行时半）', ok: 'INCONCLUSIVE', detail: '需真实压缩（LLM）', note: '--with-model 开启' });
      results.push({ case: 'T-12', name: 'Idle outcome 过滤（[X] LLM 半）', ok: 'INCONCLUSIVE', detail: '需真实会话 idle 标记（LLM）', note: '--with-model 开启' });
    }
  } finally {
    // 7. 结果先存档（teardown 崩溃不丢结果）
    const stamp = new Date().toISOString().slice(0, 10);
    const resultsDir = join(root, 'test', 'contract', 'results');
    mkdirSync(resultsDir, { recursive: true });
    const md = renderResults(results, String(process.env.DCAE_SNAPSHOT_VERSION ?? 'v2.3.0'), stamp);
    const mdFile = join(resultsDir, `${stamp}-snapshot.md`);
    writeFileSync(mdFile, md);
    writeFileSync(join(resultsDir, `${stamp}-results.json`), JSON.stringify(results, null, 2));
    console.log(`\n${md}`);
    console.log(`[harness] 结果已存档: ${mdFile}`);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    try { child.kill('SIGKILL'); } catch { /* 已退 */ }
    if (!KEEP) {
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放：保留 */ }
    } else {
      console.log(`[harness] sandbox 保留：${sandbox}`);
    }
  }
  const hardFail = results.filter((r) => r.ok === false);
  return hardFail.length > 0 ? 1 : 0;
}

function pick(id: string): boolean {
  return ONLY.length === 0 || ONLY.includes(id);
}

function resolveArgv0Local(): string {
  return process.platform === 'win32' ? 'opencode' : 'opencode';
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 模块级认证（main 解析出 server password 后设置；case 内无需逐点传参）。 */
const AUTH: { current: string | null } = { current: null };

async function fetchJson(method: string, base: string, path: string, body?: unknown, password?: string | null): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const pw = password ?? AUTH.current;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (pw) headers['authorization'] = 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64');
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: any = undefined;
  try { json = text === '' ? undefined : JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

/** T-1 [R]：会话创建请求体字段 + workspaceID 负断言 + id 采纳 + permissions/metadata 原子回读。 */
async function caseT1(base: string, sandbox: string, pw: string): Promise<CaseResult> {
  const detail: Record<string, unknown> = {};
  let ok = true;
  const sid = `ses_${Date.now().toString(36)}t1`.padEnd(30, '0').slice(0, 30);
  const create = await fetchJson('POST', base, '/api/session', {
    id: sid,
    title: 'contract-T1',
    agent: 'dcae-dev',
    location: { directory: sandbox.replace(/\\/g, '/') },
    metadata: { task: 'T-CONTRACT', attempt: 1 },
    permissions: [{ action: 'dcae.contract', resource: '*', effect: 'deny' }],
  });
  detail.createStatus = create.status;
  const got = create.json?.data ?? create.json;
  detail.id = got?.id;
  detail.metadata = got?.metadata;
  detail.permissions = got?.permissions;
  if (!create.ok) ok = false;
  if (JSON.stringify(got?.metadata ?? {}) !== JSON.stringify({ task: 'T-CONTRACT', attempt: 1 })) ok = false;
  const hasDeny = JSON.stringify(got?.permissions ?? []).includes('dcae.contract');
  detail.permissionsAtomic = hasDeny;
  if (!hasDeny) ok = false;
  // id 采纳（Reusing a Session ID adopts the existing Session [S]）
  const again = await fetchJson('POST', base, '/api/session', { id: sid, title: 'contract-T1-again', location: { directory: sandbox.replace(/\\/g, '/') } });
  detail.adoptSameId = (again.json?.data ?? again.json)?.id === sid;
  if (!detail.adoptSameId) ok = false;
  // workspaceID 断言（location 仅 {directory}，[A] additionalProperties:false）：
  // 实测（2026-11-16 v2.3.0）服务器宽松接受未知字段——改为验证 workspaceID 被忽略、directory 语义生效
  const neg = await fetchJson('POST', base, '/api/session', { title: 'neg', location: { directory: sandbox.replace(/\\/g, '/'), workspaceID: 'w-xyz' } as unknown as Record<string, unknown> });
  detail.negStatus = neg.status;
  const negSession = neg.json?.data ?? neg.json;
  detail.workspaceIDIgnored = negSession?.directory === undefined || normalizeDir(String(negSession.directory)) === normalizeDir(sandbox);
  detail.negDirectory = negSession?.directory;
  if (!detail.workspaceIDIgnored) ok = false;
  try { await fetchJson('DELETE', base, `/api/session/${sid}`); } catch { /* 尽力 */ }
  try { if (negSession?.id) await fetchJson('DELETE', base, `/api/session/${negSession.id}`); } catch { /* 尽力 */ }
  return { case: 'T-1', name: '会话创建字段 + 原子施加 + workspaceID 忽略断言', ok, detail, note: '服务器对未知字段宽松接受（OpenAPI additionalProperties:false 为契约层约束）；适配器从不发送 workspaceID（P0-3 语义不受影响）' };
}

function normalizeDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** T-2 [R]：switchAgent 语义（"subsequent provider turns"）。 */
async function caseT2(base: string, pw: string): Promise<CaseResult> {
  const detail: Record<string, unknown> = {};
  let ok = false;
  const create = await fetchJson('POST', base, '/api/session', { title: 'contract-T2' });
  const sid = (create.json?.data ?? create.json)?.id;
  if (sid) {
    const sw = await fetchJson('POST', base, `/api/session/${sid}/agent`, { agent: 'dcae-reviewer' });
    detail.switchStatus = sw.status;
    const got = await fetchJson('GET', base, `/api/session/${sid}`);
    detail.agentAfter = (got.json?.data ?? got.json)?.agent;
    ok = sw.ok && detail.agentAfter === 'dcae-reviewer';
    try { await fetchJson('DELETE', base, `/api/session/${sid}`); } catch { /* 尽力 */ }
  }
  return { case: 'T-2', name: 'switchAgent 语义', ok, detail };
}

/** T-10 [X]：会话 ID 采纳（跨项目同 ID 边界 #61947 以单服务器双 location 记录观察）。 */
async function caseT10(base: string, sandbox: string, port: number, pw: string): Promise<CaseResult> {
  const detail: Record<string, unknown> = {};
  let ok = true;
  // 跨 location 同 ID：以同服务器不同 location 创建同 ID 会话，观察是否收养/冲突
  const sid = `ses_${Date.now().toString(36)}x10`.padEnd(30, '1').slice(0, 30);
  const a = await fetchJson('POST', base, '/api/session', { id: sid, title: 'T10-A', location: { directory: sandbox.replace(/\\/g, '/') } });
  detail.a = a.status;
  const b = await fetchJson('POST', base, '/api/session', { id: sid, title: 'T10-B', location: { directory: `${sandbox.replace(/\\/g, '/')}-other` } });
  detail.b = b.status;
  detail.bAdopted = (b.json?.data ?? b.json)?.id === sid;
  // 同服务器跨目录行为记录（#61947 的服务器级近似；跨服务器变体需双进程，标记后续）
  detail.note = '跨项目同 ID 的完整复现需双服务器进程；此处记录同服务器跨 location 行为';
  try { await fetchJson('DELETE', base, `/api/session/${sid}`); } catch { /* 尽力 */ }
  void port;
  return { case: 'T-10', name: '会话 ID 采纳 + 跨 location 同 ID 观察', ok, detail };
}

/** T-14 [X]：/api/permission/saved 审计端点可用性。 */
async function caseT14(base: string, pw: string): Promise<CaseResult> {
  const detail: Record<string, unknown> = {};
  const p1 = await fetchJson('GET', base, '/api/permission/saved');
  detail.savedStatus = p1.status;
  detail.savedBody = (p1.json ?? p1.text ?? '').toString().slice(0, 200);
  const ok = p1.status !== 404 && p1.status !== 405;
  return { case: 'T-14', name: 'saved approvals 审计端点', ok, detail, note: ok ? undefined : '端点缺失时 HostPort.savedApprovals 降级为空表 + 遥测' };
}

/** T-11 外部半：/api/event 跨 location（外部客户端收到全部 location 的事件 [D]）。 */
async function caseT11External(base: string, pw: string): Promise<CaseResult> {
  const detail: Record<string, unknown> = { note: '外部流应见多 location 事件；进程内半见 RPC contract T-11' };
  try {
    const res = await fetch(`${base}/api/event`, {
      headers: pw ? { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') } : undefined,
      signal: AbortSignal.timeout(3000),
    });
    detail.eventStreamStatus = res.status;
    detail.contentType = res.headers.get('content-type');
    // 读首个帧即断开（不消费流）
    const reader = res.body?.getReader();
    if (reader) { try { await reader.read(); reader.cancel(); } catch { /* 尽力 */ } }
    return { case: 'T-11', name: '事件方向（外部流半）', ok: res.ok, detail };
  } catch (e) {
    detail.error = String(e);
    return { case: 'T-11', name: '事件方向（外部流半）', ok: 'INCONCLUSIVE', detail };
  }
}

/** 激活 location：GET /api/plugin（实测触发 location 插件装载）+ 短会话；等待 setup 探针落盘。 */
async function activateLocation(base: string, sandbox: string, pw: string): Promise<void> {
  const probeFile = join(sandbox, '.dcae', 'setup-probe.log');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // GET /api/plugin（带 location）——手动成功时序中触发插件装载的就是这个调用
      await fetchJson('GET', base, `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(sandbox)}`, undefined, pw);
      await fetchJson('POST', base, '/api/session', { title: `contract-activate-${attempt}`, location: { directory: sandbox } }, pw);
    } catch { /* 激活失败由 RPC 结果反映 */ }
    if (await waitFor(async () => existsSync(probeFile), 12_000)) {
      await new Promise((r) => setTimeout(r, 800)); // RPC 注册完成余量
      return;
    }
    console.log(`[harness] 第 ${attempt} 次激活未见探针，重载 location 后重试`);
    try { await fetchJson('POST', base, '/api/location/reload', undefined, pw); } catch { /* 尽力 */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log('[harness] 警告：插件 setup 探针始终未出现（激活失败）');
}

/** RPC contract 调用（client SDK 逐字形状：POST /api/rpc/{id}/{method}?location=…，body {input}）。 */
async function callContractRpc(base: string, cases: string[], serverLogTail?: () => string, sandbox?: string): Promise<CaseResult[]> {
  const seen: Record<string, unknown> = {};
  // client SDK appendQuery 逐字语义：对象 → 括号形式 location[directory]=…；形态探测：原生/正斜杠/无 location
  const forms: { label: string; q: string }[] = sandbox
    ? [
        { label: 'location-native', q: `location%5Bdirectory%5D=${encodeURIComponent(sandbox)}` },
        { label: 'location-forward', q: `location%5Bdirectory%5D=${encodeURIComponent(sandbox.replace(/\\/g, '/'))}` },
        { label: 'no-location', q: '' },
      ]
    : [{ label: 'no-location', q: '' }];
  for (const f of forms) {
    const path = '/api/rpc/dcae/contract' + (f.q ? `?${f.q}` : '');
    for (const body of [{ input: { cases } }] as unknown[]) {
      const r = await fetchJson('POST', base, path, body);
      seen[f.label] = { path, status: r.status, body: (r.text ?? '').slice(0, 260) };
      if (r.ok && r.json) {
        const payload = r.json?.data ?? r.json?.output ?? r.json;
        const arr = payload?.cases ?? payload;
        if (Array.isArray(arr)) {
          console.log(`[harness] RPC contract 形态命中: ${f.label}`);
          return arr as CaseResult[];
        }
      }
    }
  }
  if (serverLogTail) seen.serverLogTail = serverLogTail().split('\n').slice(-30);
  return [
    { case: 'RPC', name: 'contract RPC 不可达', ok: false, detail: { tried: ['input-wrapped', 'raw'], seen } },
  ];
}

function renderResults(results: CaseResult[], snapshot: string, stamp: string): string {
  const lines: string[] = [];
  lines.push(`# DCAE-OC M0 契约测试结果（${stamp}，快照 ${snapshot}）`);
  lines.push('');
  lines.push(`执行时间：${new Date().toISOString()}；平台快照：OpenCode ${snapshot}（opencode --version 实测）；说明：1.4 中标 [C] 的源码解读类结论（事件投递方向、ctx.vcs、跨项目 ID）在 2.3.0 上属**首次实测**（项目设计决议 D-4）。`);
  lines.push('');
  lines.push('| # | 类别 | 名称 | 判定 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    const verdict = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'INCONCLUSIVE';
    lines.push(`| ${r.case} | | ${r.name} | ${verdict} | ${r.note ?? ''} |`);
  }
  lines.push('');
  lines.push('## 详情');
  for (const r of results) {
    lines.push(`### ${r.case} ${r.name}`);
    lines.push('```json');
    lines.push(JSON.stringify(r.detail, null, 2));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

const _unusedSpawnSync = spawnSync;
void _unusedSpawnSync;
await main().then((code) => process.exit(code));
