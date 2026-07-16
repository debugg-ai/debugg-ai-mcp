/**
 * Bead pqgj — ngrok.connect() fails on attempt 1/3 for EVERY run with
 * "invalid tunnel configuration", then recovers on retry.
 *
 * ROOT CAUSE (captured live against the real ngrok agent v3.38.0, not guessed):
 *
 *   [ 110ms] STDOUT msg="starting web service" addr=127.0.0.1:4043
 *   [ 110ms] >>> getProcess() RESOLVES HERE  <-- ngrok.connect() starts tunnelling
 *   [ 403ms] STDOUT msg="client session established"   <-- ~293ms LATER
 *
 * ngrok's getProcess() resolves as soon as the agent prints its local API
 * address, but the agent's *client session* is not established for another
 * ~293ms. connect() calls startTunnel() immediately into that window, and:
 *
 *   attempt 1 -> 503 {"error_code":104,"msg":"ngrok is not yet ready to start
 *                tunnels","details":{"err":"a successful ngrok tunnel session
 *                has not yet been established"}}
 *
 * That 503 is retriable (ngrok's own isRetriable() knows about it) BUT the
 * 503-ing request still REGISTERS the tunnel name in the agent, and ngrok's
 * connectRetry() retains opts.name across its internal retries:
 *
 *   async function connectRetry(opts, retryCount = 0) {
 *     opts.name = String(opts.name || uuid.v4());   // <-- set once, then reused
 *
 * so the internal retry collides with the record its own 503 left behind:
 *
 *   attempt 2 -> 400 {"error_code":102,"msg":"invalid tunnel configuration",
 *                "details":{"err":"tunnel \"987be511-...\" already exists"}}
 *
 * 400 is NOT retriable -> thrown to us -> our ladder logs "invalid tunnel
 * configuration", resets the agent (a no-op: Node's require cache keeps ngrok's
 * module state) and reconnects, which mints a FRESH name and succeeds.
 *
 * The config diff between the failing attempts and the succeeding one is the
 * `name` field, and the reason attempt 1 fails at all is that we tunnel into a
 * not-yet-established session.
 *
 * THE FAKE BELOW ENCODES THAT MISBEHAVIOUR — it is deliberately WRONG/SLOW in
 * exactly the way the real agent is. It is NOT a stipulated-correct mock: if
 * you tunnel before the session is up, it 503s AND leaves an orphan record,
 * and a reused name gets "already exists" — same as prod.
 */

import { jest } from '@jest/globals';
import { createInMemoryRegistry } from '../../services/ngrok/tunnelRegistry.js';

// ── A faithful fake of the ngrok agent + npm package ─────────────────────────

/** ms between the agent's local API coming up and the client session being ready. */
const SESSION_READY_MS = 30;
/** ngrok's connectRetry() internal backoff. */
const INTERNAL_RETRY_MS = 10;

interface StartTunnelOpts { name?: string; proto?: string; addr?: string; hostname?: string }

class FakeNgrokAgent {
  /** Tunnel records held by the agent, keyed by tunnel name. */
  tunnelsByName = new Map<string, { orphan: boolean; hostname?: string }>();
  sessionEstablished = false;
  spawnedAt: number | null = null;
  spawnCount = 0;
  /** Every config object the agent's /api/tunnels actually received. */
  startTunnelConfigs: StartTunnelOpts[] = [];

  spawn(onStatusChange?: (s: string) => void): void {
    this.spawnCount++;
    this.spawnedAt = Date.now();
    setTimeout(() => {
      this.sessionEstablished = true;
      onStatusChange?.('connected');
    }, SESSION_READY_MS);
  }

  /** Mirrors the real agent's /api/tunnels POST behaviour. */
  startTunnel(opts: StartTunnelOpts): { public_url: string } {
    this.startTunnelConfigs.push({ ...opts });
    const name = String(opts.name);

    // Real agent: a name that already exists is rejected outright, ready or not.
    if (this.tunnelsByName.has(name)) {
      throw makeClientError(400, 'invalid tunnel configuration', {
        error_code: 102,
        status_code: 400,
        msg: 'invalid tunnel configuration',
        details: { err: `tunnel "${name}" already exists` },
      });
    }

    if (!this.sessionEstablished) {
      // THE POISONING: the 503-ing request still registers the tunnel record.
      this.tunnelsByName.set(name, { orphan: true, hostname: opts.hostname });
      throw makeClientError(503, 'ngrok is not yet ready to start tunnels', {
        error_code: 104,
        status_code: 503,
        msg: 'ngrok is not yet ready to start tunnels',
        details: { err: 'a successful ngrok tunnel session has not yet been established' },
      });
    }

    this.tunnelsByName.set(name, { orphan: false, hostname: opts.hostname });
    return { public_url: `https://${opts.hostname}` };
  }
}

function makeClientError(statusCode: number, msg: string, body: any): Error {
  const err = new Error(msg) as any;
  err.name = 'NgrokClientError';
  err.response = { statusCode };
  err.body = body;
  return err;
}

/** ngrok/src/utils.js isRetriable() — verbatim semantics. */
function isRetriable(err: any): boolean {
  if (!err.response) return false;
  const statusCode = err.response.statusCode;
  const body = err.body;
  const notReady502 =
    statusCode === 502 && body?.details?.err === 'tunnel session not ready yet';
  const notReady503 =
    statusCode === 503 &&
    body?.details?.err === 'a successful ngrok tunnel session has not yet been established';
  return notReady502 || notReady503;
}

let agent: FakeNgrokAgent;
/** ngrok/src/process.js memoizes the spawn — model that. */
let processPromise: Promise<string> | null = null;
let uuidCounter = 0;
const connectCalls: any[] = [];

/** Mirrors ngrok/src/process.js getProcess(): resolves at "starting web service". */
async function fakeGetProcess(opts: any): Promise<string> {
  if (processPromise) return processPromise;
  processPromise = (async () => {
    agent.spawn(opts?.onStatusChange);
    return 'http://127.0.0.1:4043';
  })();
  return processPromise;
}

/** Mirrors ngrok/index.js connect() + connectRetry(), including name retention. */
async function fakeConnect(opts: any): Promise<string> {
  connectCalls.push({ ...opts });
  // defaults(): split global vs tunnel props (name is NOT a tunnel prop upstream).
  const globalOpts = {
    authtoken: opts.authtoken,
    onStatusChange: opts.onStatusChange,
    onTerminated: opts.onTerminated,
  };
  const tunnelOpts: StartTunnelOpts = {
    proto: opts.proto,
    addr: opts.addr,
    hostname: opts.hostname,
  };
  await fakeGetProcess(globalOpts);

  const connectRetry = async (o: StartTunnelOpts, retryCount = 0): Promise<string> => {
    o.name = String(o.name || `uuid-${++uuidCounter}`); // set ONCE, reused on retry
    try {
      return agent.startTunnel(o).public_url;
    } catch (err) {
      if (!isRetriable(err) || retryCount >= 100) throw err;
      await new Promise((r) => setTimeout(r, INTERNAL_RETRY_MS));
      return connectRetry(o, retryCount + 1);
    }
  };
  return connectRetry(tunnelOpts);
}

const mockNgrokDisconnect = jest.fn<() => Promise<void>>();
const mockNgrokGetApi = jest.fn();

jest.unstable_mockModule('ngrok', () => ({
  connect: fakeConnect,
  disconnect: mockNgrokDisconnect,
  getApi: mockNgrokGetApi,
  default: { connect: fakeConnect, disconnect: mockNgrokDisconnect, getApi: mockNgrokGetApi },
}));

let TunnelManagerClass: typeof import('../../services/ngrok/tunnelManager.js').default;

beforeAll(async () => {
  ({ default: TunnelManagerClass } = await import('../../services/ngrok/tunnelManager.js'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockNgrokDisconnect.mockResolvedValue(undefined as any);
  mockNgrokGetApi.mockReturnValue(null);
  agent = new FakeNgrokAgent();
  processPromise = null;
  uuidCounter = 0;
  connectCalls.length = 0;
});

/**
 * Wire the manager's agent-session seam to the fake agent, mirroring what the
 * production default does with ngrok's real getProcess().
 */
function wireFakeAgent(tm: any): void {
  tm.reg = createInMemoryRegistry();
  tm.connectBackoffMs = [50, 50];
  tm.agentSessionStarter = async (o: any) => { await fakeGetProcess(o); };
}

// ── pqgj ─────────────────────────────────────────────────────────────────────

describe('bead pqgj: ngrok agent session readiness', () => {
  test('connect() succeeds on the FIRST attempt — no not-ready window, no name collision', async () => {
    const tm: any = new TunnelManagerClass();
    wireFakeAgent(tm);

    const result = await tm.processUrl('http://localhost:39117', 'tok-abc', 'tid-1');

    expect(result.isLocalhost).toBe(true);
    // THE ASSERTION THAT MATTERS: one connect, not a reset-and-retry.
    expect(connectCalls).toHaveLength(1);
    // The agent saw exactly one tunnel config, and it succeeded.
    expect(agent.startTunnelConfigs).toHaveLength(1);
  });

  test('leaves NO orphan tunnel record behind (the 503 poisons the reserved domain)', async () => {
    const tm: any = new TunnelManagerClass();
    wireFakeAgent(tm);

    await tm.processUrl('http://localhost:39117', 'tok-abc', 'tid-2');

    const orphans = [...agent.tunnelsByName.values()].filter((t) => t.orphan);
    expect(orphans).toEqual([]);
    expect(agent.tunnelsByName.size).toBe(1);
  });

  test('waits for the session before tunnelling, so the agent is never 503-raced', async () => {
    const tm: any = new TunnelManagerClass();
    wireFakeAgent(tm);

    await tm.processUrl('http://localhost:39117', 'tok-abc', 'tid-3');

    // Every startTunnel the agent saw happened with an established session.
    expect(agent.startTunnelConfigs).toHaveLength(1);
    expect(agent.sessionEstablished).toBe(true);
  });

  test('SAFETY NET: if the session starter is unavailable, the retry ladder still gets a tunnel', async () => {
    const tm: any = new TunnelManagerClass();
    tm.reg = createInMemoryRegistry();
    tm.connectBackoffMs = [50, 50];
    // Simulate the deep-require of ngrok's internals breaking on a version bump.
    tm.agentSessionStarter = async () => { throw new Error('getProcess unavailable'); };

    const result = await tm.processUrl('http://localhost:39117', 'tok-abc', 'tid-4');

    expect(result.isLocalhost).toBe(true);
    expect(result.url).toContain('tid-4.ngrok.debugg.ai');
    // The ladder did its job: it took a retry, but we still got a tunnel.
    expect(connectCalls.length).toBeGreaterThan(1);
  });
});
