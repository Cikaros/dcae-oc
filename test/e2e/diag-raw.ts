/** dump 一条 assistant 消息的原始 JSON：bun test/e2e/diag-raw.ts <port> <pw> <wt> <sid> */
const [, , port, pw, wt = "", sid] = process.argv;
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') };
const loc = encodeURIComponent(JSON.stringify({ directory: wt.replace(/\\/g, '/') }));
const res = await fetch(`${base}/api/session/${sid}/message?limit=100&location=${loc}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
const arr = (JSON.parse(await res.text()).data ?? []) as any[];
const a = arr.find((m) => m.type === 'assistant' && m.finish === 'stop') ?? arr.find((m) => m.type === 'assistant');
console.log(JSON.stringify(a, null, 1).slice(0, 3000));

export {};
