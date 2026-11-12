/**
 * Executor session loop: attach, long-poll commands, run them one at a time through
 * the OpRunner, post results, heartbeat, honour cancel/drain, give up when the cloud
 * stays unreachable past the lease. Transport-agnostic (see httpTransport.ts).
 */
import type { Command, CommandResult, SessionLimits } from './ops.js';
import { OpRunner } from './opRunner.js';

export interface AttachInfo {
  executor_version: string;
  ops_supported: readonly string[];
  browser: { name: string; version?: string; headless: boolean };
  profile: 'ephemeral' | 'mcp_owned';
  credential_labels: string[];
}

export interface ExecutorTransport {
  attach(info: AttachInfo): Promise<void>;
  /** Long-poll; resolves [] on timeout. Must reject with an AbortError-like when `signal` fires. */
  poll(waitS: number, signal: AbortSignal): Promise<Command[] | { commands: Command[]; cancel?: boolean; drain?: boolean }>;
  postResults(results: CommandResult[]): Promise<void>;
  heartbeat(): Promise<{ cancel: boolean; drain: boolean }>;
}

export interface SessionOptions {
  transport: ExecutorTransport;
  runner: OpRunner;
  attach: AttachInfo;
  limits: SessionLimits;
  signal?: AbortSignal;
  pollWaitS?: number;
  /** Override for tests. */
  retryDelayMs?: number;
}

export type SessionEnd = 'cancelled' | 'drained' | 'aborted' | 'lease_lost' | 'closed_by_cloud';

export async function runExecutorSession(o: SessionOptions): Promise<{ ended: SessionEnd; commandsRun: number }> {
  const { transport, runner, limits } = o;
  const stop = new AbortController();
  let ended: SessionEnd | null = null;
  const finish = (why: SessionEnd) => { if (!ended) { ended = why; stop.abort(); } };
  o.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
  if (o.signal?.aborted) finish('aborted');

  await transport.attach(o.attach);

  let lastContact = Date.now();
  const retryDelay = o.retryDelayMs ?? 1000;
  const hb = setInterval(() => {
    transport.heartbeat().then((r) => {
      lastContact = Date.now();
      if (r.cancel) finish('cancelled'); else if (r.drain) finish('drained');
    }).catch(() => { if (Date.now() - lastContact > limits.lease_s * 1000) finish('lease_lost'); });
  }, Math.max(limits.heartbeat_s * 1000, 50));

  const done = new Map<string, CommandResult>(); // idempotent replays
  const inflight = new Set<string>(); // the cloud re-delivers unfinished commands; never run one twice
  let commandsRun = 0;
  try {
    while (!ended) {
      let cmds: Command[];
      try {
        const polled = await transport.poll(o.pollWaitS ?? 25, stop.signal);
        lastContact = Date.now();
        if (Array.isArray(polled)) cmds = polled;
        else { cmds = polled.commands ?? []; if (polled.cancel) { finish('cancelled'); break; } if (polled.drain && cmds.length === 0) { finish('drained'); break; } }
      } catch (err) {
        if (ended) break;
        if (Date.now() - lastContact > limits.lease_s * 1000) { finish('lease_lost'); break; }
        await sleep(retryDelay, stop.signal);
        continue;
      }
      const conc = Math.max(1, limits.max_inflight ?? cmds.length);
      let next = 0;
      const worker = async () => {
        while (next < cmds.length && !ended) {
          const cmd = cmds[next++];
          const key = cmd.idempotency_key ?? cmd.id;
          if (inflight.has(key)) continue;
          inflight.add(key);
          const cached = done.get(key);
          let result: CommandResult;
          try { result = cached ? { ...cached, command_id: cmd.id } : await runner.execute(cmd); } finally { inflight.delete(key); }
          if (!cached) { done.set(key, result); commandsRun++; if (done.size > 200) done.delete(done.keys().next().value as string); }
          // Results are idempotent by command_id on the cloud side, so retrying a post is safe.
          for (let attempt = 0; ; attempt++) {
            try { await transport.postResults([result]); lastContact = Date.now(); break; }
            catch {
              if (ended || Date.now() - lastContact > limits.lease_s * 1000) { finish('lease_lost'); break; }
              await sleep(retryDelay * Math.min(attempt + 1, 5), stop.signal);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, cmds.length) }, worker));
    }
  } finally {
    clearInterval(hb);
    await runner.close();
  }
  return { ended: ended ?? 'closed_by_cloud', commandsRun };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
}
