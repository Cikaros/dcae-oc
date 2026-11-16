/** 读内核日志尾部：bun test/e2e/diag-klog.ts <projDir> [grepWord] */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const [, , proj, grep] = process.argv;
const lines = readFileSync(join(proj, '.dcae', 'logs', 'kernel.log'), 'utf8').split('\n').filter(Boolean);
const tail = lines.slice(-40);
for (const l of tail) {
  if (!grep || l.includes(grep)) console.log(l.slice(0, 300));
}
