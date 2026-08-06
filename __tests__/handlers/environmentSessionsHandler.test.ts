/**
 * environment sessions / clearSessions (sentinal-cs1hn.5).
 *
 * The backend keeps a warm authenticated session per account and restores it to
 * skip login. That cache decides WHO a run signs in as, and it used to be
 * invisible: a run reusing the wrong account's session looked exactly like a run
 * that found no login form, and clearing one needed a shell on the backend.
 * These pin the MCP's half — you can see what is held, and you can drop it.
 */
import { jest } from '@jest/globals';
import type { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockList = jest.fn<(...a: any[]) => Promise<any>>();
const mockClear = jest.fn<(...a: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    listEnvironmentSessions: mockList,
    clearEnvironmentSessions: mockClear,
  })),
}));

const { environmentHandler } = await import('../../handlers/environmentHandler.js');
const { EnvironmentInputSchema } = await import('../../types/index.js');

const ENV_UUID = '11111111-1111-1111-1111-111111111111';
const CRED_UUID = '22222222-2222-2222-2222-222222222222';
const ctx = {} as ToolContext;

function payload(res: any) {
  return JSON.parse(res.content[0].text);
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    uuid: '33333333-3333-3333-3333-333333333333',
    username: 'qa-mcr@example.com',
    role: 'staff',
    backendRef: '',
    credential: CRED_UUID,
    credentialLabel: 'staff',
    status: 'valid',
    isUsable: true,
    capturedAt: '2026-08-06T00:00:00Z',
    lastValidatedAt: '2026-08-06T00:00:00Z',
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInit.mockResolvedValue(undefined);
  mockList.mockResolvedValue([]);
  mockClear.mockResolvedValue({ invalidated: 0 });
});

// ── schema ──────────────────────────────────────────────────────────────────

describe('input schema', () => {
  test('sessions and clearSessions are accepted actions', () => {
    for (const action of ['sessions', 'clearSessions']) {
      expect(EnvironmentInputSchema.safeParse({ action, uuid: ENV_UUID }).success).toBe(true);
    }
  });

  test('both accept username / credentialId narrowing', () => {
    const parsed = EnvironmentInputSchema.safeParse({
      action: 'clearSessions', uuid: ENV_UUID,
      username: 'artist@example.com', credentialId: CRED_UUID,
    });
    expect(parsed.success).toBe(true);
  });

  test('an environment uuid is required — there is no "clear every environment"', () => {
    expect(EnvironmentInputSchema.safeParse({ action: 'clearSessions' }).success).toBe(false);
  });
});

// ── sessions ────────────────────────────────────────────────────────────────

describe('action: sessions', () => {
  test('lists what the environment is holding, per account', async () => {
    mockList.mockResolvedValue([
      session(),
      session({ username: 'artist@example.com', isUsable: false, status: 'stale' }),
    ]);

    const body = payload(await environmentHandler(
      { action: 'sessions', uuid: ENV_UUID } as any, ctx,
    ));

    expect(body.sessions.map((s: any) => s.username))
      .toEqual(['qa-mcr@example.com', 'artist@example.com']);
  });

  test('reports how many would actually be REUSED, not just how many exist', async () => {
    mockList.mockResolvedValue([session(), session({ isUsable: false })]);

    const body = payload(await environmentHandler(
      { action: 'sessions', uuid: ENV_UUID } as any, ctx,
    ));

    expect(body.pageInfo).toEqual({ totalCount: 2, usableCount: 1 });
  });

  test('says plainly when nothing is cached, so "no login form" is not a mystery', async () => {
    const body = payload(await environmentHandler(
      { action: 'sessions', uuid: ENV_UUID } as any, ctx,
    ));

    expect(body.sessions).toEqual([]);
    expect(body.note).toMatch(/logs in for real/);
  });

  test('narrowing filters reach the API', async () => {
    await environmentHandler(
      { action: 'sessions', uuid: ENV_UUID, username: 'artist@example.com' } as any, ctx,
    );
    expect(mockList).toHaveBeenCalledWith(ENV_UUID, { username: 'artist@example.com' });
  });

  test('absent filters are omitted rather than sent as undefined', async () => {
    await environmentHandler({ action: 'sessions', uuid: ENV_UUID } as any, ctx);
    expect(mockList).toHaveBeenCalledWith(ENV_UUID, {});
  });
});

// ── clearSessions ───────────────────────────────────────────────────────────

describe('action: clearSessions', () => {
  test('a narrowed clear runs without confirmation', async () => {
    mockClear.mockResolvedValue({ invalidated: 1 });

    const body = payload(await environmentHandler(
      { action: 'clearSessions', uuid: ENV_UUID, username: 'artist@example.com' } as any, ctx,
    ));

    expect(mockClear).toHaveBeenCalledWith(ENV_UUID, { username: 'artist@example.com' });
    expect(body).toMatchObject({ invalidated: 1, scope: 'artist@example.com' });
  });

  test('an UNSCOPED clear is confirmed first — it costs every account a login', async () => {
    const res: any = await environmentHandler(
      { action: 'clearSessions', uuid: ENV_UUID } as any, ctx,
    );

    // No confirm and no client elicitation capability => refused, nothing cleared.
    expect(mockClear).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });

  test('an unscoped clear proceeds once confirmed', async () => {
    mockClear.mockResolvedValue({ invalidated: 3 });

    const body = payload(await environmentHandler(
      { action: 'clearSessions', uuid: ENV_UUID, confirm: true } as any, ctx,
    ));

    expect(mockClear).toHaveBeenCalledWith(ENV_UUID, {});
    expect(body).toMatchObject({ invalidated: 3, scope: 'all accounts' });
  });

  test('clearing nothing is reported honestly, not as success', async () => {
    const body = payload(await environmentHandler(
      { action: 'clearSessions', uuid: ENV_UUID, username: 'nobody@example.com' } as any, ctx,
    ));

    expect(body.invalidated).toBe(0);
    expect(body.note).toMatch(/Nothing to clear/);
  });
});
