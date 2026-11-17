/** follow 模式读日志流 5 秒：bun test/e2e/diag-logfollow.ts <port> <pw> <wt> <sid> */
const [, , port, pw, wt = "", sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
const res = await fetch(`${base}/api/experimental/session/${sid}/log?after=0&follow=true&location=${loc}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
console.log('status =', res.status);
const reader = res.body!.getReader();
const dec = new TextDecoder();
let buf = '';
const timer = setTimeout(() => { try { reader.cancel(); } catch { } }, 5000);
let frames = 0;
try {
  while (frames < 40) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (line.startsWith('data:')) {
        frames++;
        if (frames <= 10) console.log('FRAME', line.slice(0, 220));
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  }
} finally {
  clearTimeout(timer);
}
console.log('total frames =', frames);

export {};
