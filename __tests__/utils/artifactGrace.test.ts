import { describe, test, expect, jest } from '@jest/globals';
import { refreshPendingArtifacts, artifactsPending } from '../../utils/artifactGrace.js';

const q = { recordingStatus: 'queued_for_download', harUrl: null, consoleLogUrl: null };

describe('refreshPendingArtifacts (bead w1os.3)', () => {
  test('no re-read when nothing is queued', async () => {
    const get = jest.fn<any>();
    const out = await refreshPendingArtifacts(get, 'x', { harUrl: null, consoleLogUrl: null, harStatus: 'not_available' }, { intervalMs: 1 });
    expect(get).not.toHaveBeenCalled();
    expect(out?.harStatus).toBe('not_available');
  });
  test('picks up URLs that arrive on a later read', async () => {
    const get = jest.fn<any>()
      .mockResolvedValueOnce({ browserSession: q })
      .mockResolvedValueOnce({ browserSession: { recordingStatus: 'downloaded', harUrl: 'https://s3/h.har', consoleLogUrl: 'https://s3/c.log' } });
    const out = await refreshPendingArtifacts(get, 'x', q, { intervalMs: 1 });
    expect(out?.harUrl).toBe('https://s3/h.har');
    expect(get).toHaveBeenCalledTimes(2);
  });
  test('bounded: gives up after attempts and relays last state; read errors are swallowed', async () => {
    const get = jest.fn<any>().mockResolvedValue({ browserSession: q });
    const out = await refreshPendingArtifacts(get, 'x', q, { attempts: 2, intervalMs: 1 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(artifactsPending(out)).toBe(true);
    const bad = jest.fn<any>().mockRejectedValue(new Error('boom'));
    expect((await refreshPendingArtifacts(bad, 'x', q, { intervalMs: 1 }))?.recordingStatus).toBe('queued_for_download');
  });
});
