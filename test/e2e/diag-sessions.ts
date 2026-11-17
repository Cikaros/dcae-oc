/** 列出并清理僵尸会话：bun test/e2e/diag-sessions.ts <port> <pw> <projDir> [--kill] */
const [, , port, pw, proj = "", doKill] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: proj.replace(/\\/g, '/') }));

// 列全部会话（canonical + 无 location 过滤）
const res = await fetch(`${base}/api/session?limit=100&location=${loc}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
const text = await res.text();
const arr = (JSON.parse(text).data ?? []) as any[];
console.log('sessions =', arr.length);
for (const s of arr) {
  console.log(`- ${s.id} title="${s.title ?? ''}" outcome=${s.outcome ?? '-'} agent=${s.agent ?? '-'}`);
}
if (doKill === '--kill') {
  for (const s of arr) {
    const dr = await fetch(`${base}/api/session/${s.id}?location=${loc}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(15_000) });
    console.log(`del ${s.id} -> ${dr.status}`);
  }
  console.log('cleanup done');
}

export {};
