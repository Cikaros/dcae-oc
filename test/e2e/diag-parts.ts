/** dump 会话消息的 parts 原始结构：bun test/e2e/diag-parts.ts <port> <pw> <wt> <sid> */
const [, , port, pw, wt, sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
const res = await fetch(`${base}/api/session/${sid}/message?limit=100&location=${loc}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
const arr = (JSON.parse(await res.text()).data ?? []) as any[];
for (const m of arr) {
  if (m.type !== 'assistant') continue;
  console.log('--- assistant finish=' + m.finish);
  for (const p of m.parts ?? []) {
    const preview = JSON.stringify(p).slice(0, 260);
    console.log('  [' + p.type + '] ' + preview);
  }
}
