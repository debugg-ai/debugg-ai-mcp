import { jest } from '@jest/globals';
import { E2eTestRunner } from '../../e2e-agents/e2eRunner.js';
import { E2eRun } from '../../services/types.js';

// Minimal E2eRun factory
function makeRun(status: string, key = 'test-key'): E2eRun {
    return { uuid: 'run-uuid', key, status } as any;
}

// Mock client whose getE2eRun returns statuses from a sequence
function makeMockClient(statusSequence: (string | null)[]): any {
    let call = 0;
    return {
        e2es: {
            getE2eRun: jest.fn(async () => {
                const entry = statusSequence[Math.min(call++, statusSequence.length - 1)];
                return entry === null ? null : makeRun(entry);
            })
        }
    };
}

describe('E2eTestRunner.handleE2eRun', () => {
    let runner: E2eTestRunner;
    let stopTunnelSpy: jest.SpyInstance;
    let sleepSpy: jest.SpyInstance;

    beforeEach(() => {
        runner = new E2eTestRunner(null as any);
        // Make sleep instant so tests don't take forever
        sleepSpy = jest.spyOn(runner as any, '_sleep').mockResolvedValue(undefined);
        stopTunnelSpy = jest.spyOn(runner as any, '_stopTunnel').mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('terminates when status becomes completed', async () => {
        runner['client'] = makeMockClient(['running', 'running', 'completed']);

        const updates: string[] = [];
        await runner.handleE2eRun(makeRun('running'), async (run) => {
            updates.push(run.status);
        });

        expect(updates[updates.length - 1]).toBe('completed');
        expect(stopTunnelSpy).toHaveBeenCalledTimes(1);
    });

    test('calls onUpdate on every poll tick', async () => {
        runner['client'] = makeMockClient(['running', 'running', 'completed']);
        const onUpdate = jest.fn().mockResolvedValue(undefined);

        await runner.handleE2eRun(makeRun('running'), onUpdate);

        // 3 polls → 3 onUpdate calls
        expect(onUpdate).toHaveBeenCalledTimes(3);
    });

    test('calls onUpdate even when getE2eRun returns null', async () => {
        // null, null, then completed
        runner['client'] = makeMockClient([null, null, 'completed']);
        const onUpdate = jest.fn().mockResolvedValue(undefined);

        await runner.handleE2eRun(makeRun('running'), onUpdate);

        // 3 ticks even though first two returned null
        expect(onUpdate).toHaveBeenCalledTimes(3);
        // Last call should still have the original run (since polls returned null)
        expect(onUpdate.mock.calls[2][0].status).toBe('completed');
    });

    test('continues polling when getE2eRun throws', async () => {
        let call = 0;
        runner['client'] = {
            e2es: {
                getE2eRun: jest.fn(async () => {
                    call++;
                    if (call === 1) throw new Error('network error');
                    return makeRun('completed');
                })
            }
        };
        const onUpdate = jest.fn().mockResolvedValue(undefined);

        await runner.handleE2eRun(makeRun('running'), onUpdate);

        // tick 1: poll threw, onUpdate called with original run
        // tick 2: poll returned completed, onUpdate called, loop exits
        expect(onUpdate).toHaveBeenCalledTimes(2);
        expect(stopTunnelSpy).toHaveBeenCalledTimes(1);
    });

    test('calls _stopTunnel in finally even when onUpdate throws', async () => {
        runner['client'] = makeMockClient(['running', 'completed']);

        await expect(
            runner.handleE2eRun(makeRun('running'), async () => {
                throw new Error('progress notification failed');
            })
        ).rejects.toThrow('progress notification failed');

        expect(stopTunnelSpy).toHaveBeenCalledTimes(1);
    });

    test('calls _stopTunnel with the correct tunnel URL', async () => {
        runner['client'] = makeMockClient(['completed']);
        const run = makeRun('running', 'my-unique-key');

        await runner.handleE2eRun(run, jest.fn().mockResolvedValue(undefined));

        expect(stopTunnelSpy).toHaveBeenCalledWith('https://my-unique-key.ngrok.debugg.ai');
    });

    test('terminates on timeout without calling stopTunnel twice', async () => {
        // Never completes — forces timeout path
        runner['client'] = makeMockClient(['running']);

        // Make Date.now jump past the timeout on the first check inside the loop
        const fixedStart = 1_000_000;
        let nowCall = 0;
        jest.spyOn(Date, 'now').mockImplementation(() => {
            // First call (startTime assignment): return fixedStart
            // Subsequent calls (timeout check): return fixedStart + TIMEOUT_MS + 1
            return nowCall++ === 0 ? fixedStart : fixedStart + 900_001;
        });

        const onUpdate = jest.fn().mockResolvedValue(undefined);
        await runner.handleE2eRun(makeRun('running'), onUpdate);

        // Timed out before any poll fired
        expect(onUpdate).toHaveBeenCalledTimes(0);
        expect(stopTunnelSpy).toHaveBeenCalledTimes(1);
    });

    test('returns the last known run state', async () => {
        runner['client'] = makeMockClient(['running', 'completed']);
        const onUpdate = jest.fn().mockResolvedValue(undefined);

        const result = await runner.handleE2eRun(makeRun('pending'), onUpdate);

        expect(result.status).toBe('completed');
    });
});

describe('E2eTestRunner.handleE2eRun — progress heartbeat', () => {
    test('onUpdate fires on every tick regardless of step count change', async () => {
        const runner = new E2eTestRunner(null as any);
        jest.spyOn(runner as any, '_sleep').mockResolvedValue(undefined);
        jest.spyOn(runner as any, '_stopTunnel').mockResolvedValue(undefined);

        // Same run returned on every poll — step count never changes
        const staticRun = makeRun('running');
        runner['client'] = {
            e2es: {
                getE2eRun: jest.fn()
                    .mockResolvedValueOnce(staticRun)
                    .mockResolvedValueOnce(staticRun)
                    .mockResolvedValueOnce(makeRun('completed'))
            }
        };

        const onUpdate = jest.fn().mockResolvedValue(undefined);
        await runner.handleE2eRun(makeRun('running'), onUpdate);

        // All 3 poll ticks should have fired onUpdate
        expect(onUpdate).toHaveBeenCalledTimes(3);

        jest.restoreAllMocks();
    });
});
