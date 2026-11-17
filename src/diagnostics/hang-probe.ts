/**
 * 挂起探针（诊断资产）：每个平台调用都包 8s 超时护栏，谁超时谁就是堵点。
 * 通过 DCAE_PROBE=1 启用；超时事件写 .dcae/probe-timeout.log。
 */
import type { Plugin } from '@opencode/plugin';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Ctx = Plugin.Context;

const PROBE_MS = 8_000;

function probeLog(canonical: string, msg: string): void {
  try {
    mkdirSync(join(canonical, '.dcae'), { recursive: true });
    appendFileSync(join(canonical, '.dcae', 'probe-timeout.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 尽力 */ }
}

async function withTimeout<T>(canonical: string, name: string, p: Promise<T>, ms = PROBE_MS): Promise<T | null> {
  let done = false;
  const t = setTimeout(() => {
    if (!done) {
      done = true;
      probeLog(canonical, `TIMEOUT ${name} (>${ms}ms)`);
    }
  }, ms);
  try {
    const r = await Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);
    done = true;
    clearTimeout(t);
    return r;
  } catch (e) {
    done = true;
    clearTimeout(t);
    probeLog(canonical, `ERROR ${name}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

export const hangProbe = { probeLog, withTimeout, PROBE_MS };
void (undefined as unknown as Ctx);
