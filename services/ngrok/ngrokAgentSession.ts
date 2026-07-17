/**
 * ngrok agent session bootstrap (bead pqgj).
 *
 * ngrok's connect() calls its internal getProcess() and then IMMEDIATELY asks
 * the agent to open a tunnel. But getProcess() resolves as soon as the agent
 * prints its local API address, which — measured live against agent v3.38.0 —
 * is ~293ms BEFORE the client session is established:
 *
 *   [ 110ms] msg="starting web service" addr=127.0.0.1:4043   <- getProcess resolves
 *   [ 403ms] msg="client session established"                 <- ~293ms later
 *
 * Tunnelling inside that window returns 503 "a successful ngrok tunnel session
 * has not yet been established". That 503 is retriable and ngrok retries it
 * internally — but connectRetry() pins opts.name on the first call and reuses
 * it, so its own retry collides with the tunnel record the 503 left behind:
 * 400 "invalid tunnel configuration — tunnel already exists". 400 is not
 * retriable, so it surfaces to us. That is bead pqgj's 100% attempt-1 failure.
 *
 * Fix: start the agent and wait for its session BEFORE anyone tunnels.
 * getProcess() memoizes on a module-level promise, so ngrok's own connect()
 * then reuses the very agent we started and never re-spawns it.
 *
 * getProcess is not in ngrok's package export map ({".": "./index.js"}), hence
 * the resolved deep require. It is isolated in this module so the reach into
 * another package's internals is explicit, greppable, and mockable — and so a
 * version bump that moves it fails HERE, loudly, instead of silently spawning
 * something unexpected. Callers treat a throw as "no pre-warm available" and
 * fall back to their connect retry ladder.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Options forwarded to the ngrok agent process. These are ngrok "global"
 * properties — the ones its defaults() splits out and hands to getProcess().
 */
export interface AgentSessionOpts {
  authtoken: string;
  /** Called with 'connected' when the agent logs "client session established". */
  onStatusChange: (status: string) => void;
  /** Called when the agent process exits. */
  onTerminated: () => void;
}

export type AgentSessionStarter = (opts: AgentSessionOpts) => Promise<void>;

/**
 * Spawn (or reuse) the ngrok agent, wiring the session callbacks.
 *
 * Resolves once the agent's local API is up — NOT once the session is live.
 * Callers await the session via `onStatusChange('connected')`.
 *
 * @throws if ngrok's internals cannot be reached (version bump, stubbed module).
 */
export const startAgentSession: AgentSessionStarter = async (opts) => {
  const require = createRequire(import.meta.url);
  const ngrokEntry = require.resolve('ngrok');
  const processModulePath = join(dirname(ngrokEntry), 'src', 'process.js');
  const { getProcess } = require(processModulePath);
  if (typeof getProcess !== 'function') {
    throw new Error(`ngrok getProcess() not found at ${processModulePath}`);
  }
  await getProcess(opts);
};
