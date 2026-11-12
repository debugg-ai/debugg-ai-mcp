/**
 * Step loop: brain decides, LocalExecutor acts. Enforces the caps the backend cannot
 * be trusted to (step count, wall clock, abort) and writes artifacts locally (0600).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { debuggHome, ensurePrivateDir } from '../localBrowser.js';
import { LocalExecutor, type LocalExecutorOptions } from './executor.js';
import { PROTOCOL_VERSION, type Action, type StepResult } from './types.js';

export type Verdict = 'pass' | 'fail' | 'inconclusive';

export interface BrainDone { type: 'done'; verdict: Verdict; reason: string; evidence?: number[] }
export type BrainDecision = Action | BrainDone;

/** The cloud brain, as the MCP sees it. Real implementation is an HTTPS client (see docs section 2). */
export interface Brain {
  open(req: { task: string; url: string; protocol: number; viewport: { width: number; height: number }; credentialLabels: string[] }): Promise<{ sessionId: string }>;
  /** `prev` is null on the first call; the brain answers with the next action or a verdict. */
  step(sessionId: string, seq: number, prev: StepResult | null): Promise<BrainDecision>;
  cancel(sessionId: string, reason: string): Promise<void>;
}

export interface RunOptions extends LocalExecutorOptions {
  task: string;
  brain: Brain;
  maxSteps?: number;
  maxWallMs?: number;
}

export interface RunStepRecord {
  seq: number;
  action: Action | BrainDone;
  ok: boolean;
  error?: string;
  url: string;
  screenshotPath?: string;
}

export interface RunResult {
  verdict: Verdict;
  reason: string;
  stoppedBy: 'brain' | 'max_steps' | 'timeout' | 'aborted' | 'error';
  steps: RunStepRecord[];
  artifactsDir: string;
  durationMs: number;
}

export async function runLocalCheck(o: RunOptions): Promise<RunResult> {
  const maxSteps = Math.min(o.maxSteps ?? 25, 100);
  const maxWallMs = Math.min(o.maxWallMs ?? 5 * 60_000, 15 * 60_000);
  const t0 = Date.now();
  const runId = randomUUID().slice(0, 8);
  const dir = path.join(debuggHome(), 'captures', `run-${Date.now()}-${runId}`);
  ensurePrivateDir(dir);
  const steps: RunStepRecord[] = [];
  const result = (verdict: Verdict, reason: string, stoppedBy: RunResult['stoppedBy']): RunResult =>
    ({ verdict, reason, stoppedBy, steps, artifactsDir: dir, durationMs: Date.now() - t0 });

  const ex = await LocalExecutor.open(o);
  let sessionId: string | undefined;
  const expired = () => (o.signal?.aborted ? 'aborted' : Date.now() - t0 > maxWallMs ? 'timeout' : null);
  try {
    ({ sessionId } = await o.brain.open({
      task: o.task, url: o.startUrl, protocol: PROTOCOL_VERSION,
      viewport: { width: 1280, height: 800 }, credentialLabels: Object.keys(o.secrets ?? {}),
    }));
    let prev: StepResult | null = { actionResult: { ok: true }, observation: await ex.observe() };
    for (let seq = 1; seq <= maxSteps + 1; seq++) {
      const stop = expired();
      if (stop) { await o.brain.cancel(sessionId, stop).catch(() => {}); return result('inconclusive', stop === 'aborted' ? 'Run was cancelled.' : `Run exceeded ${maxWallMs} ms.`, stop); }
      const decision = await o.brain.step(sessionId, seq, prev);
      if (decision.type === 'done') {
        steps.push({ seq, action: decision, ok: true, url: prev.observation.url });
        return result(decision.verdict, decision.reason, 'brain');
      }
      if (seq > maxSteps) {
        await o.brain.cancel(sessionId, 'max_steps').catch(() => {});
        return result('inconclusive', `Step limit (${maxSteps}) reached before the brain gave a verdict.`, 'max_steps');
      }
      prev = await ex.execute(decision);
      const rec: RunStepRecord = { seq, action: decision, ok: prev.actionResult.ok, url: prev.observation.url };
      if (prev.actionResult.error) rec.error = `${prev.actionResult.error.code}: ${prev.actionResult.error.message}`;
      if (prev.observation.screenshotBase64) {
        const file = path.join(dir, `step-${String(seq).padStart(2, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(prev.observation.screenshotBase64, 'base64'), { mode: 0o600 });
        rec.screenshotPath = file;
      }
      steps.push(rec);
    }
    return result('inconclusive', 'Step limit reached.', 'max_steps');
  } catch (err) {
    if (sessionId) await o.brain.cancel(sessionId, 'error').catch(() => {});
    if (o.signal?.aborted) return result('inconclusive', 'Run was cancelled.', 'aborted');
    throw err;
  } finally {
    await ex.close();
  }
}
