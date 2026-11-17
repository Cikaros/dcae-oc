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

function normalizeDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 插件进程内可拿到的 ctx 适配输入。 */
export interface AdapterCtx {
  ctx: Plugin.Context;
  /** HTTP REST 兜底基址（config.serverUrl / env DCAE_OPENCODE_URL）。 */
  httpBase?: string;
  /** session.idle 事件信号（Kernel 登记；awaitIdle 进程内权威 idle 信号）。 */
  idleSignal?: (sessionId: string, sinceMs: number) => string | null;
}

export function createOpenCodeHost(input: AdapterCtx): HostPort {
  const { ctx } = input;
  const idleSignal = input.idleSignal;
  const httpBase = normalizeBase(input.httpBase ?? process.env.DCAE_OPENCODE_URL);
  // 会话所在 location（REST 兜底调用必须按会话 location 路由——worktree 会话在 canonical 视角不可见，实测教训）
  const sessionDirs = new Map<string, string>();

  function locationQuery(id: string): string {
    const dir = sessionDirs.get(id);
    return dir ? `&location%5Bdirectory%5D=${encodeURIComponent(dir)}` : '';
  }

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
      sessionDirs.set(i.id, i.directory.replace(/\\/g, '/'));
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
      // 30s 护栏（实测：向已 idle 会话注入 queue 消息可能无限挂起，堵死事件循环——
      // 调用方（提醒/门禁提示/返工通知）全部 fire-and-forget，挂起只损失该次注入）
      const out = await Promise.race([
        ctx.session.prompt({
          sessionID: id,
          id: o.messageId,
          text,
          delivery: o.delivery ?? 'steer',
        } as any),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('prompt-timeout(30s)')), 30_000)),
      ]);
      return { messageId: (out as any)?.id ?? o.messageId };
    },

    async awaitIdle(id, o) {
      // 轮询版（实测修正：ctx.session.wait 对运行中会话的阻塞实现会堵死事件循环）：
      // idle 信号 = session.idle 事件登记（kernel.noteSessionIdle，实例事件流原生广播）；
      // 终态区分 = ctx.session.get().outcome（failed/interrupted 有值，正常 idle undefined）。
      const deadline = Date.now() + o.timeoutMs;
      const since = Date.now();
      const { hangProbe } = await import('../diagnostics/hang-probe.ts');
      while (Date.now() < deadline) {
        if (o.signal.aborted) return 'timeout';
        // 1. 事件信号（实例事件流）
        const evOutcome = idleSignal?.(id, since);
        if (evOutcome === 'idle') return 'idle';
        if (evOutcome === 'failed') return 'failed';
        if (evOutcome === 'interrupted') return 'interrupted';
        // 2. 终态信号（进程内 get；8s 护栏——挂起即记录并继续，假死定位探针）
        const raw = await hangProbe.withTimeout(
          ctx.location.project.canonical, `session.get(${id.slice(0, 20)})`,
          ctx.session.get({ sessionID: id } as any) as Promise<any>,
        );
        const outcome = (raw as any)?.outcome;
        // 实测（2026-11-17）：干净结束的会话 outcome=succeeded（进程内 Session.Info 权威）。
        // 早期轮询版误删该分支，只认 failed/interrupted，导致正常 idle 永不被识别、
        // REVIEW 闭环空等到 30 分钟超时升级（根因，已复现）。
        if (outcome === 'succeeded') return 'idle';
        if (outcome === 'failed') return 'failed';
        if (outcome === 'interrupted') return 'interrupted';
        await new Promise((r) => setTimeout(r, 5_000));
      }
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

    async sessionMessages(id) {
      const out = await httpJson<any>('GET', `/api/session/${encodeURIComponent(id)}/message?limit=200${locationQuery(id)}`);
      const arr = Array.isArray(out) ? out : ((out?.data as any[]) ?? []);
      return (arr ?? []).map((m: any) => {
        // 实测（2026-11-17）：REST 消息的部件字段是 content（含 reasoning/text/tool），非 parts
        const content: any[] = Array.isArray(m?.content) ? m.content : (Array.isArray(m?.parts) ? m.parts : []);
        const text = content.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text ?? '')).join('\n');
        const tools = content
          .filter((p: any) => p?.type === 'tool')
          .map((p: any) => ({ name: String(p.tool ?? p.name ?? ''), input: p.input ?? p.state?.input }));
        return {
          type: String(m?.type ?? ''),
          finish: m?.finish,
          outcome: m?.outcome,
          error: m?.error ? { type: m.error.type, message: m.error.message } : undefined,
          text: text.length > 0 ? text : undefined,
          tools: tools.length > 0 ? tools : undefined,
        };
      });
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
      if (httpBase) {
        try {
          const act = await httpJson<Record<string, any>>('GET', '/api/session/active');
          active = Object.prototype.hasOwnProperty.call(act ?? {}, id);
        } catch {
          active = info.outcome === undefined; // REST 不可用：未终态近似为活跃（保守）
        }
      } else {
        // 无 REST（进程内常态）：Session.Info 无终态 outcome ⇒ 视为活跃（保守近似，实测驱动）
        active = info.outcome === undefined;
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
      // 签名 {projectID, from?, branch?, directory?, name?}（[D]，WorktreeCreateInput 已核实）。
      // 实测：branch = 起始 ref（"Starting ref"）；from = 源目录语义（传非目录值 → DirectoryUnavailableError），
      // 故 HostPort 的 o.branch 映射平台 branch；o.from 仅在接受目录语义时透传（本设计不用）。
      // 幂等（原则 5）：DestinationExistsError → 复用既有同名 worktree（dispatch 重试语义）。
      try {
        const out = await ctx.worktree.create({
          projectID,
          name,
          ...(o?.branch !== undefined ? { branch: o.branch } : {}),
          ...(o?.from !== undefined ? { from: o.from } : {}),
        } as any);
        return { directory: String((out as any)?.directory ?? '') };
      } catch (e) {
        if (!/DestinationExists/i.test(String(e))) throw e;
        const list = (await ctx.worktree.list({ projectID } as never)) as readonly { directory: string }[];
        const hit = (list ?? []).find((w) => normalizeDir(w.directory).endsWith('/' + name));
        if (hit) return { directory: hit.directory };
        throw e;
      }
    },

    async listWorktrees(projectID) {
      const out = (await ctx.worktree.list({ projectID } as never)) as readonly { directory: string; type?: string }[];
      return (out ?? []).map((w) => ({ directory: String(w.directory ?? ''), type: w.type as 'root' | 'worktree' | undefined }));
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
    const out = await httpJson<any>('GET', `/api/experimental/session/${encodeURIComponent(id)}/log?after=${after}${locationQuery(id)}`);
    const arr = Array.isArray(out) ? out : ((out?.data as any[]) ?? []);
    return arr.map((it, i) => ({ seq: Number(it.seq ?? after + i), ts: it.ts ?? it.time, type: it.type, data: it }));
  }
}

/** 消息尾部最近一个 idle 标记的 outcome —— 已弃用：idle/终态判定改走 ctx.session.get().outcome
 * （awaitIdle 内联实现）；sessionMessages 保留给 HostPort 接口完备性（有 httpBase 的部署可用）。 */
async function latestIdleMarker(_host: HostPort, _id: string): Promise<'succeeded' | 'failed' | 'interrupted' | null> {
  return null;
}
void latestIdleMarker;
