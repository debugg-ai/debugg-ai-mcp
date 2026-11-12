/**
 * HTTPS transport for the Browser Executor API v1. Outbound only. Paths follow the
 * platform draft (sentinal docs/local-executor-api-design.md section 3) and are kept in
 * one table because the lead has not frozen them yet.
 */
import type { Command, CommandResult } from './ops.js';
import { API_VERSION } from './ops.js';
import type { AttachInfo, ExecutorTransport } from './session.js';

export const EXECUTOR_PATHS = {
  attach: (id: string) => `/api/v1/executors/sessions/${id}/attach`,
  commands: (id: string, waitS: number) => `/api/v1/executors/sessions/${id}/commands?wait=${waitS}`,
  results: (id: string) => `/api/v1/executors/sessions/${id}/results`,
  heartbeat: (id: string) => `/api/v1/executors/sessions/${id}/heartbeat`,
  cancel: (id: string) => `/api/v1/executors/sessions/${id}/cancel`,
};

export interface HttpTransportOptions { baseUrl: string; /** Full Authorization header value, e.g. `Token abc` or `Bearer abc`. */ authorization: string; sessionId: string; secret: string; fetchImpl?: typeof fetch }

export class HttpTransportError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}

export class HttpExecutorTransport implements ExecutorTransport {
  constructor(private readonly o: HttpTransportOptions) {}

  private async req(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(this.o.baseUrl.replace(/\/$/, '') + path, {
      method,
      signal,
      headers: {
        authorization: this.o.authorization,
        'x-executor-secret': this.o.secret,
        'x-executor-api-version': String(API_VERSION),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new HttpTransportError(`${method} ${path.split('?')[0]} -> HTTP ${res.status}`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async attach(info: AttachInfo): Promise<void> { await this.req('POST', EXECUTOR_PATHS.attach(this.o.sessionId), info); }
  async poll(waitS: number, signal: AbortSignal): Promise<Command[] | { commands: Command[]; cancel?: boolean; drain?: boolean }> {
    const r = await this.req('GET', EXECUTOR_PATHS.commands(this.o.sessionId, waitS), undefined, signal);
    if (Array.isArray(r)) return r;
    const o = (r ?? {}) as { commands?: Command[]; cancel?: boolean; drain?: boolean };
    return { commands: o.commands ?? [], cancel: o.cancel, drain: o.drain };
  }
  async postResults(results: CommandResult[]): Promise<void> { await this.req('POST', EXECUTOR_PATHS.results(this.o.sessionId), { results }); }
  async heartbeat(): Promise<{ cancel: boolean; drain: boolean }> {
    const r = (await this.req('POST', EXECUTOR_PATHS.heartbeat(this.o.sessionId), {})) as { cancel?: boolean; drain?: boolean } | null;
    return { cancel: !!r?.cancel, drain: !!r?.drain };
  }
}
