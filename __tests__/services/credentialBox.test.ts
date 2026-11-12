import { describe, test, expect } from '@jest/globals';
import { generateSessionKeys, sealTo } from '../../services/localExecutor/credentialBox.js';
import { runExecutorSession } from '../../services/localExecutor/session.js';
import type { Command, CommandResult } from '../../services/localExecutor/ops.js';

describe('sealed credential box', () => {
  test('round trip; wrong key, wrong session id, tampering all fail', () => {
    const a = generateSessionKeys(); const b = generateSessionKeys();
    const env = sealTo(a.publicKey, 'p@ss w0rd', 'S1');
    expect(a.open(env, 'S1')).toBe('p@ss w0rd');
    expect(() => b.open(env, 'S1')).toThrow();
    expect(() => a.open(env, 'S2')).toThrow();
    expect(() => a.open({ ...env, ct: Buffer.from('xx').toString('base64') }, 'S1')).toThrow();
    expect(JSON.stringify(env)).not.toContain('p@ss');
  });
  test('only the public key is exposed by the keys object', () => {
    const k = generateSessionKeys();
    expect(Object.keys(k).sort()).toEqual(['open', 'publicKey']);
    expect(JSON.stringify(k)).not.toMatch(/PRIVATE/);
  });
});

describe('session concurrency', () => {
  const mk = (n: number): Command[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, seq: i, op: 'title' }));
  async function run(limits: object) {
    let active = 0; let peak = 0; let served = false; const ac = new AbortController();
    const runner = { execute: async (c: Command): Promise<CommandResult> => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 40)); active--; return { command_id: c.id, ok: true, duration_ms: 40 }; }, close: async () => {} };
    const posted: string[] = [];
    const transport = {
      attach: async () => {},
      poll: async () => { if (served) { ac.abort(); return []; } served = true; return mk(4); },
      postResults: async (r: CommandResult[]) => { posted.push(r[0].command_id); },
      heartbeat: async () => ({ cancel: false, drain: false }),
    };
    await runExecutorSession({ transport, runner: runner as never, attach: {} as never, limits: { heartbeat_s: 5, lease_s: 5, max_inline_bytes: 1, max_batch: 4, ...limits } as never, signal: ac.signal });
    return { peak, posted };
  }
  test('no cap by default; max_inflight is honoured when the backend sets it', async () => {
    expect((await run({})).peak).toBe(4);
    const one = await run({ max_inflight: 1 });
    expect(one.peak).toBe(1);
    expect(one.posted).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect((await run({ max_inflight: 2 })).peak).toBe(2);
  });
});
