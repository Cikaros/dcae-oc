/** dump 会话日志条目结构：bun test/e2e/diag-log.ts <port> <pw> <wt> <sid> */
const [, , port, pw, wt, sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
const res = await fetch(`${base}/api/experimental/session/${sid}/log?after=0&location=${loc}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
const text = await res.text();
console.log('status =', res.status, 'bytes =', text.length);
const parsed = JSON.parse(text);
const arr: any[] = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.items ?? []);
console.log('items =', arr.length);
for (const it of arr.slice(-8)) {
  console.log('ITEM keys=' + Object.keys(it).join(','), 'type=' + (it.type ?? it.kind ?? '?'));
  console.log('  ' + JSON.stringify(it).slice(0, 300));
}
