/**
 * OpenCodeHost —— HostPort 的 OpenCode V2 适配器（架构设计 §4 映射表）。
 *
 * 主实现走进程内 ctx 域 API；ctx 不覆盖的方法（environment PUT、session.log、
 * session.active、permission/saved）走 HTTP REST 兜底（base 址经 config/env 注入）。
 * 每个方法的后备与失败语义见方法注释；实验性调用失败一律抛 HostUnavailable，
 * 由内核层决定降级路径（原则 9：平台变动隔离在 HostPort 之后）。
 */
import { spawn } from 'node:child_process';
import type { Plugin } from '@opencode/plugin';
import {
  HostUnavailable,
  type ExecOptions,
  type ExecResult,
  type HostPort,
  type Rule,
  type SavedApproval,
  type SessionInfo,
  type SessionLogItem,
} from './port.ts';
import { resolveArgv0 } from '../util/argv-resolve.ts';

/** 插件进程内可拿到的 ctx 适配输入。 */
export interface AdapterCtx {
  ctx: Plugin.Context;
  /** HTTP REST 兜底基址（config.serverUrl / env DCAE_OPENCODE_URL）。 */
  httpBase?: string;
}

export function createOpenCodeHost(input: AdapterCtx): HostPort {
  const { ctx } = input;
  const httpBase = normalizeBase(input.httpBase ?? process.env.DCAE_OPENCODE_URL);

  async function httpJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!httpBase) throw new HostUnavailable(`HTTP 兜底不可用（无 serverUrl）: ${method} ${path}`, 'no-http-base');
    let res: Response;
    try {
      res = await fetch(httpBase + path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new HostUnavailable(`HTTP ${method} ${path} 失败: ${String(e)}`, 'http-error');
    }
    if (!res.ok) throw new HostUnavailable(`HTTP ${method} ${path} -> ${res.status}`, 'http-error');
    const text = await res.text();
    return (text === '' ? (undefined as T) : (JSON.parse(text) as T));
  }

  function mapSessionInfo(raw: any): SessionInfo {
    if (!raw || typeof raw !== 'object') return { id: String(raw ?? '') };
    return {
      id: String(raw.id ?? ''),
      directory: raw.directory ?? undefined,
      title: raw.title ?? undefined,
      agent: raw.agent ?? undefined,
      metadata: raw.metadata ?? undefined,
      outcome: raw.outcome ?? undefined,
      tokens: raw.tokens
        ? {
            input: Number(raw.tokens.input ?? 0),
            output: Number(raw.tokens.output ?? 0),
            reasoning: Number(raw.tokens.reasoning ?? 0),
            cacheRead: raw.tokens.cache?.read,
            cacheWrite: raw.tokens.cache?.write,
          }
        : undefined,
      costUsd: typeof raw.cost === 'object' && raw.cost !== null ? Number(raw.cost.value ?? raw.cost.amount ?? 0) : Number(raw.cost ?? 0) || undefined,
    };
  }

  return {
    async createSession(i) {
      // location 仅 {directory}（Location.PublicRef，[A]）；workspaceID 不入请求体（1.4 P0-3）
      const out = await ctx.session.create({
        id: i.id,
        parentID: i.parentID ?? null,
        title: i.title,
        agent: i.agent,
        ...(i.model ? { model: { id: i.model.id, providerID: i.model.providerID, ...(i.model.variant ? { variant: i.model.variant } : {}) } } : {}),
        location: { directory: i.directory },
        metadata: (i.metadata ?? null) as any,
        permissions: (i.permissions as Rule[] | undefined) ?? null,
      });
      return mapSessionInfo(out);
    },

    async setPermissions(id, rules) {
      await ctx.session.update({ sessionID: id, permissions: rules as Rule[] });
    },

    async interrupt(id, resume) {
      // [A] resume 语义：interrupt 终止当前步；resume=true 时恢复执行延续同一 turn
      await ctx.session.interrupt({ sessionID: id, ...(resume !== undefined ? { resume } : {}) } as never);
    },

    async setEnvironment(id, env) {
      // ctx 域无 environment；HTTP PUT 整体替换（[A] "Replace the process environment"）
      await httpJson('PUT', `/api/session/${encodeURIComponent(id)}/environment`, { variables: env });
    },

    async putInstruction(id, key, value) {
      // 实验性 entries；键 ^[a-z0-9][a-z0-9._-]*$（[A]）；单值 ≤256 KiB（[S]）
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : Buffer.byteLength(JSON.stringify(value));
      if (bytes > 256 * 1024) throw new Error(`instruction entry 超出 256 KiB（${bytes} bytes）：${key}`);
      await (ctx.session as any).instructions.entry.put({ sessionID: id, key, value });
    },

    async prompt(id, text, o) {
      const out = await ctx.session.prompt({
        sessionID: id,
        id: o.messageId,
        text,
        delivery: o.delivery ?? 'steer',
      } as any);
      return { messageId: (out as any)?.id ?? o.messageId };
    },

    async awaitIdle(id, o) {
      // wait 无请求体（[A]：204/503）；AbortSignal 实现超时；返回后经日志尾部 Idle 标记 outcome 判定（§7.2）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.timeoutMs);
      const onOuterAbort = () => controller.abort();
      o.signal.addEventListener('abort', onOuterAbort, { once: true });
      try {
        await (ctx.session as any).wait({ sessionID: id }, { signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) {
          if (o.signal.aborted) return 'timeout';
          return 'timeout';
        }
        // 503 等失败：落入日志轮询路径
      } finally {
        clearTimeout(timer);
        o.signal.removeEventListener('abort', onOuterAbort);
      }
      const marker = await latestIdleMarker(this, id);
      if (marker === 'succeeded') return 'idle';
      if (marker === 'failed') return 'failed';
      if (marker === 'interrupted') return 'interrupted';
      // wait 返回但无标记：早返回竞态（T-w）——保守报 timeout，内核按无提交空闲路径处置
      return 'timeout';
    },

    async *sessionLog(id, after, o) {
      // experimental.session.log（[A]）：HTTP GET，after 为数字游标，follow 为流式
      const base = after ?? 0;
      if (!httpBase) throw new HostUnavailable('sessionLog 需要 HTTP 基址', 'no-http-base');
      let cursor = base;
      const follow = o?.follow ?? false;
      // 非 follow：一次拉全量增量；follow：轮询式流（事件流易失，不依赖 SSE 长连）
      for (let round = 0; round < (follow ? 10_000 : 1); round++) {
        const items = await fetchLogPage(id, cursor);
        for (const it of items) {
          yield it;
          cursor = Math.max(cursor, it.seq + 1);
        }
        if (!follow) return;
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    async sessionLogTail(id, lastN = 200) {
      const all = await fetchLogPage(id, 0);
      return lastN > 0 && all.length > lastN ? all.slice(-lastN) : all;
    },

    async getSession(id) {
      let raw: any;
      try {
        raw = await ctx.session.get({ sessionID: id });
      } catch {
        return { exists: false, active: false, directory: '', tokens: { input: 0, output: 0, reasoning: 0 }, costUsd: 0 };
      }
      const info = mapSessionInfo(raw);
      let active = false;
      try {
        const act = await httpJson<Record<string, any>>('GET', '/api/session/active');
        active = Object.prototype.hasOwnProperty.call(act ?? {}, id);
      } catch {
        active = false; // 无 HTTP 时保守报非活跃（drain 快照语义："Sessions absent from the result are inactive"）
      }
      return {
        exists: true,
        active,
        directory: info.directory ?? '',
        tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0 },
        costUsd: info.costUsd ?? 0,
        outcome: info.outcome,
        metadata: info.metadata,
        agent: info.agent,
        raw,
      };
    },

    async createWorktree(projectID, name, o) {
      // 签名 {projectID, from?, branch?, directory?, name?}（[D]，WorktreeCreateInput 已核实）
      const out = await ctx.worktree.create({
        projectID,
        name,
        ...(o?.from !== undefined ? { from: o.from } : {}),
        ...(o?.branch !== undefined ? { branch: o.branch } : {}),
      } as any);
      return { directory: String((out as any)?.directory ?? '') };
    },

    async removeWorktree(projectID, directory, force) {
      await ctx.worktree.remove({ projectID, directory, force } as any);
    },

    async exec(cmd, o) {
      // 直接 spawn，不经 shell（1.4 §6.3）；argv[0] 经 PATH 解析（Windows shim EINVAL 规避）
      const argv0 = resolveArgv0(cmd[0]!);
      const started = Date.now();
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(argv0, cmd.slice(1), {
          cwd: o.cwd,
          env: o.env ? { ...process.env, ...o.env } : process.env,
          shell: false,
          windowsHide: true,
        });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        const cap = o.maxOutputBytes ?? 2 * 1024 * 1024;
        let timedOut = false;
        const timer = o.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } }, 2_000);
            }, o.timeoutMs)
          : null;
        child.stdout.on('data', (d: Buffer) => { if (stdout.length < cap) stdout = Buffer.concat([stdout, d]); });
        child.stderr.on('data', (d: Buffer) => { if (stderr.length < cap) stderr = Buffer.concat([stderr, d]); });
        child.on('error', (err) => {
          if (timer) clearTimeout(timer);
          resolve({
            exit: null,
            stdout,
            stderr: Buffer.concat([stderr, Buffer.from(`spawn error: ${String(err)}`)]),
            timedOut,
            durationMs: Date.now() - started,
          });
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          resolve({ exit: code, stdout, stderr, timedOut, durationMs: Date.now() - started });
        });
      });
    },

    async savedApprovals() {
      // /api/permission/saved 只读审计（[A]）；404 → 空表 + reason 标记（T-14 记录）
      try {
        const out = await httpJson<any>('GET', `/api/permission/saved?projectID=${encodeURIComponent(ctx.location.project.id)}`);
        return Array.isArray(out) ? (out as SavedApproval[]) : ((out?.data as SavedApproval[]) ?? []);
      } catch (e) {
        if ((e as HostUnavailable)?.message?.includes('-> 404')) return [];
        throw e;
      }
    },

    appVersion() {
      return String((ctx.app as any)?.version ?? 'unknown');
    },
  };

  function normalizeBase(u: string | undefined): string | undefined {
    if (!u) return undefined;
    return u.replace(/\/+$/, '');
  }

  async function fetchLogPage(id: string, after: number): Promise<SessionLogItem[]> {
    const out = await httpJson<any>('GET', `/api/experimental/session/${encodeURIComponent(id)}/log?after=${after}`);
    const arr = Array.isArray(out) ? out : ((out?.data as any[]) ?? []);
    return arr.map((it, i) => ({ seq: Number(it.seq ?? after + i), ts: it.ts ?? it.time, type: it.type, data: it }));
  }
}

/** 日志尾部最近一个 Idle 标记的 outcome（无标记 → null）。 */
async function latestIdleMarker(host: HostPort, id: string): Promise<'succeeded' | 'failed' | 'interrupted' | null> {
  try {
    const tail = await host.sessionLogTail(id, 100);
    for (let i = tail.length - 1; i >= 0; i--) {
      const it = tail[i]!;
      const d = (it.data ?? {}) as any;
      const type = String(it.type ?? d.type ?? '');
      if (type.includes('idle') || d.outcome !== undefined && type !== '') {
        if (d.outcome === 'succeeded' || d.outcome === 'failed' || d.outcome === 'interrupted') return d.outcome;
      }
    }
  } catch {
    return null;
  }
  return null;
}
