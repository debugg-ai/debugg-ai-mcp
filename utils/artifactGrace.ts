/**
 * Bounded grace re-fetch for run artifacts (bead w1os.3).
 *
 * The backend uploads the HAR / console log / recording AFTER the run reaches a
 * terminal state: the first execution read often has `recordingStatus:
 * 'queued_for_download'` and null URLs. Reading once and relaying that made the
 * links look permanently absent. When any artifact status says it is still
 * queued, re-read the execution a few times, briefly, and take the fresher
 * browserSession. Nothing is invented: if the URLs still are not there, the
 * statuses are relayed as-is.
 */
import type { BrowserSession, WorkflowExecution } from '../services/workflows.js';

const PENDING = /queue|pending|processing|uploading|downloading/i;

export function artifactsPending(bs: BrowserSession | null | undefined): boolean {
  if (!bs) return false;
  const statuses = [bs.recordingStatus, bs.harStatus, bs.consoleLogStatus];
  return statuses.some((s) => typeof s === 'string' && PENDING.test(s));
}

function artifactsReady(bs: BrowserSession): boolean {
  return !artifactsPending(bs) || (!!bs.harUrl && !!bs.consoleLogUrl);
}

export async function refreshPendingArtifacts(
  getExecution: (uuid: string) => Promise<WorkflowExecution>,
  executionUuid: string,
  current: BrowserSession | null | undefined,
  opts: { attempts?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<BrowserSession | null | undefined> {
  const attempts = opts.attempts ?? 3;
  const intervalMs = opts.intervalMs ?? 2000;
  let latest = current;
  for (let i = 0; i < attempts && artifactsPending(latest) && !(latest && artifactsReady(latest)); i++) {
    if (opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const exec = await getExecution(executionUuid);
      if (exec.browserSession) latest = exec.browserSession;
    } catch {
      break; // artifact refresh is best-effort; never fail the run for it
    }
  }
  return latest;
}
