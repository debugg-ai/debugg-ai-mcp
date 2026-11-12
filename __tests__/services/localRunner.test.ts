import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome } from '../../services/localBrowser.js';
import { runLocalCheck } from '../../services/localExecutor/runner.js';
import { ScriptedBrain } from '../helpers/scriptedBrain.js';

const live = findChrome() ? describe : describe.skip;
live('runLocalCheck (real Chrome, scripted brain)', () => {
  let server: http.Server; let base = '';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-run-'));
  beforeAll(async () => {
    process.env.DEBUGGAI_LOCAL_BROWSER = '1';
    process.env.DEBUGGAI_HOME = home;
    server = http.createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>T</title><button onclick="document.body.append(\'saved!\')">Save</button>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); fs.rmSync(home, { recursive: true, force: true }); });

  test('click then verdict; artifacts local 0600', async () => {
    const brain = new ScriptedBrain((prev, seq) => {
      if (seq === 1) return { type: 'click', ref: prev.observation.elements.find((e) => e.name === 'Save')!.ref };
      return { type: 'done', verdict: prev.observation.text.includes('saved!') ? 'pass' : 'fail', reason: 'saw saved!' };
    });
    const r = await runLocalCheck({ task: 'save works', startUrl: base, brain });
    expect(r.verdict).toBe('pass');
    expect(r.stoppedBy).toBe('brain');
    expect(r.steps).toHaveLength(2);
    const shot = r.steps[0].screenshotPath!;
    expect(fs.statSync(shot).mode & 0o777).toBe(0o600);
  }, 60000);

  test('step cap stops a brain that never finishes and cancels the session', async () => {
    const brain = new ScriptedBrain(() => ({ type: 'observe' }));
    const r = await runLocalCheck({ task: 'x', startUrl: base, brain, maxSteps: 3 });
    expect(r).toMatchObject({ verdict: 'inconclusive', stoppedBy: 'max_steps' });
    expect(r.steps).toHaveLength(3);
    expect(brain.cancelled).toEqual(['max_steps']);
  }, 60000);

  test('wall clock and abort', async () => {
    const slow = new ScriptedBrain(() => ({ type: 'wait', ms: 300 }));
    const r = await runLocalCheck({ task: 'x', startUrl: base, brain: slow, maxWallMs: 700 });
    expect(r.stoppedBy).toBe('timeout');
    const ac = new AbortController();
    const brain = new ScriptedBrain((_p, seq) => { if (seq === 2) ac.abort(); return { type: 'observe' }; });
    const r2 = await runLocalCheck({ task: 'x', startUrl: base, brain, signal: ac.signal });
    expect(r2.stoppedBy).toBe('aborted');
  }, 60000);
});
