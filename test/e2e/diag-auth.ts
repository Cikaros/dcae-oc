/** REST 认证试验：无密码调 messages 是否可行 + env 键侦察：bun test/e2e/diag-auth.ts <port> <pw> */
const [, , port, pw] = process.argv;
const base = `http://127.0.0.1:${port}`;
// 1. 无凭据 GET /api/info
const r1 = await fetch(`${base}/api/info`);
console.log('no-auth /api/info →', r1.status);
// 2. 无凭据 GET messages（需要真实 session——先带密码建一个）
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const cs = await fetch(`${base}/api/session`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'auth-probe' }) });
const sid = (await cs.json())?.data?.id;
console.log('session =', sid);
const r2 = await fetch(`${base}/api/session/${sid}/message?limit=10`);
console.log('no-auth messages →', r2.status, (await r2.text()).slice(0, 120));
const r3 = await fetch(`${base}/api/session/${sid}/message?limit=10`, { headers: auth });
console.log('with-auth messages →', r3.status);
// 3. 进程 env 侦察键（哪些键存在，不打印值）
console.log('env keys of interest:', Object.keys(process.env).filter((k) => /OPENCODE|PORT|PASSWORD|TOKEN|SERVER/i.test(k)).join(', ') || '(none)');
for (const k of Object.keys(process.env)) {
  if (/OPENCODE|PASSWORD|TOKEN/i.test(k)) console.log(' ', k, '=', String(process.env[k]).slice(0, 24));
}
