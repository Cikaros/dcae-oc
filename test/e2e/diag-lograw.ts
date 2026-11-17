/** dump 会话日志原始响应：bun test/e2e/diag-lograw.ts <port> <pw> <wt> <sid> */
const [, , port, pw, wt = "", sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
for (const qs of [`after=0&location=${loc}`, `location=${loc}`]) {
  const res = await fetch(`${base}/api/experimental/session/${sid}/log?${qs}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  console.log(`[${qs.slice(0, 20)}...] status=${res.status} ct=${res.headers.get('content-type')} bytes=${text.length}`);
  console.log(text.slice(0, 600));
}

export {};
