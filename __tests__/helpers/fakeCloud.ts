import http from 'node:http';
import type { Command, CommandResult } from '../../services/localExecutor/ops.js';

/** Minimal stand-in for the Executor API v1: one session, commands queued by the test. */
export class FakeCloud {
  server!: http.Server;
  url = '';
  queue: Command[] = [];
  results: CommandResult[] = [];
  attached: Record<string, unknown> | null = null;
  uploads: Buffer[] = [];
  cancel = false;
  headers: Array<http.IncomingHttpHeaders> = [];
  private waiters: Array<() => void> = [];
  private seq = 0;

  async start(): Promise<void> {
    this.server = http.createServer((q, s) => {
      this.headers.push(q.headers);
      const chunks: Buffer[] = [];
      q.on('data', (c) => chunks.push(c));
      q.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = q.url ?? '';
        if (u.startsWith('/upload')) { this.uploads.push(body); s.writeHead(200); s.end(); return; }
        if (u.endsWith('/attach')) { this.attached = JSON.parse(body.toString()); s.writeHead(204); s.end(); return; }
        if (u.includes('/commands')) {
          const give = () => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(this.queue.splice(0, 1))); };
          if (this.queue.length) return give();
          const t = setTimeout(() => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('[]'); }, 400);
          this.waiters.push(() => { clearTimeout(t); give(); });
          return;
        }
        if (u.endsWith('/results')) {
          this.results.push(...JSON.parse(body.toString()).results);
          s.writeHead(204); s.end(); return;
        }
        if (u.endsWith('/heartbeat')) { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ cancel: this.cancel, drain: false })); return; }
        s.writeHead(404); s.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  stop() { this.server?.close(); this.server?.closeAllConnections?.(); }
  push(partial: Omit<Command, 'id' | 'seq'> & { id?: string }): string {
    const id = partial.id ?? `c_${++this.seq}`;
    this.queue.push({ seq: this.seq, ...partial, id } as Command);
    this.waiters.splice(0).forEach((w) => w());
    return id;
  }
  async result(id: string, ms = 20000): Promise<CommandResult> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = this.results.find((x) => x.command_id === id);
      if (r) return r;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    throw new Error(`no result for ${id}`);
  }
}
