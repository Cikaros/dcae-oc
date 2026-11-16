/**
 * reviewer 会话诊断：bun test/e2e/diag-review.ts <servePort> <serverPw> <worktreeDir> <sessionId>
 */
import { spawnSync } from 'node:child_process';

const [, , port, pw, wt, sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
const url = `${base}/api/session/${sid}/message?limit=100&location=${loc}`;
const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(15_000) });
const text = await res.text();
console.log('status =', res.status, 'bytes =', text.length);
try {
  const arr = (JSON.parse(text).data ?? []) as any[];
  console.log('messages =', arr.length);
  for (const m of arr) {
    const texts = Array.isArray(m.parts) ? m.parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ') : '';
    console.log(`- ${m.type} finish=${m.finish ?? '-'} model=${m.model?.id ?? '-'} textLen=${texts.length}`);
    if (m.error) console.log('  ERROR:', m.error.type, String(m.error.message ?? '').slice(0, 160));
    if (texts.length > 0) console.log('  text:', texts.slice(0, 400).replace(/\n/g, ' | '));
    const tools = Array.isArray(m.parts) ? m.parts.filter((p: any) => p?.type === 'tool').map((p: any) => p.tool) : [];
    if (tools.length > 0) console.log('  tools:', tools.join(','));
  }
} catch (e) {
  console.log('non-JSON body:', text.slice(0, 400));
}
void spawnSync;
