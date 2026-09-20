/**
 * ngrokTransport — today's ngrok client, behind the TunnelTransport seam.
 *
 * This is a MOVE, not a rewrite. Every line here came out of
 * services/ngrok/tunnelManager.ts unchanged, because the whole point of the
 * extraction is that the ngrok path keeps behaving exactly as it did while the
 * debugg transport is rolled out (design §5, bead debugg_ai_mcp-xkoh.5.5): the
 * lazy module load, `getApi()` bootstrap, the agent pre-warm, the connect
 * options (including the `https://` addr form), disconnect, and the
 * module-reset-when-no-tunnels-remain behaviour.
 *
 * It exists so that nothing on the debugg path can reach the `ngrok` package.
 * Until this file was split out, `import('ngrok')` ran on every tunnel
 * creation, every teardown and every retry, which would have meant a binary
 * download on machines that never use ngrok again.
 *
 * Deleted wholesale in the rollout arc's last step, along with
 * services/ngrok/ngrokAgentSession.ts and the `ngrok` dependency.
 */

import { Logger } from '../../utils/logger.js';
import { startAgentSession, type AgentSessionStarter } from '../ngrok/ngrokAgentSession.js';
import type { TunnelConnectOptions, TunnelTransport } from './transport.js';

const logger = new Logger({ module: 'ngrokTransport' });

let ngrokModule: any = null;

async function getNgrok() {
  if (!ngrokModule) {
    try {
      ngrokModule = await import('ngrok');
    } catch (error) {
      throw new Error(`Failed to load ngrok module: ${error}`);
    }
  }
  return ngrokModule;
}

/**
 * Reset the cached ngrok module so the next connect() bootstraps a fresh agent.
 * Called when the last tunnel is disconnected and the agent process may have died.
 */
function resetNgrokModule(): void {
  ngrokModule = null;
}

export interface NgrokTransportOptions {
  /**
   * Bead pqgj: how the ngrok agent gets started and how we learn its client
   * session is live. Overridable so tests drive a fake agent instead of
   * spawning a real ngrok process.
   */
  agentSessionStarter?: AgentSessionStarter;
  /**
   * Cap on waiting for "client session established". Measured live at ~293ms;
   * this is a generous ceiling, not an expected wait. On expiry we tunnel
   * anyway and let the retry ladder handle it — a slow session must not become
   * a hang.
   */
  agentSessionTimeoutMs?: number;
}

class NgrokTransport implements TunnelTransport {
  readonly kind = 'ngrok' as const;

  /** Public so TunnelManager can keep exposing its existing test seams. */
  agentSessionStarter: AgentSessionStarter;
  agentSessionTimeoutMs: number;

  /** Whether the ngrok agent's client session is established (bead pqgj). */
  private agentSessionReady = false;
  /** In-flight session bootstrap, so concurrent tunnels wait on one spawn. */
  private agentSessionPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(opts: NgrokTransportOptions = {}) {
    this.agentSessionStarter = opts.agentSessionStarter ?? startAgentSession;
    this.agentSessionTimeoutMs = opts.agentSessionTimeoutMs ?? 5000;
  }

  /**
   * Bead pqgj: make sure the ngrok agent's client session is established before
   * we ask it for a tunnel, so attempt 1 lands on a ready agent instead of the
   * ~293ms not-ready window that made every single run fail its first connect.
   *
   * Never throws: if the agent can't be pre-warmed (ngrok internals moved, slow
   * session, dead token) we fall through and let the retry ladder do what it
   * did before this fix. The ladder stays a genuine safety net.
   */
  async prepare(authtoken: string): Promise<void> {
    await this.ensureInitialized();
    if (this.agentSessionReady) return;

    if (!this.agentSessionPromise) {
      this.agentSessionPromise = (async () => {
        let markEstablished!: () => void;
        const established = new Promise<void>((resolve) => { markEstablished = resolve; });

        await this.agentSessionStarter({
          authtoken,
          onStatusChange: (status: string) => {
            if (status === 'connected') {
              this.agentSessionReady = true;
              markEstablished();
            } else if (status === 'closed') {
              this.agentSessionReady = false;
            }
          },
          onTerminated: () => {
            // Agent process died — next tunnel must re-warm.
            this.agentSessionReady = false;
            this.agentSessionPromise = null;
          },
        });

        let capTimer: NodeJS.Timeout | undefined;
        const cap = new Promise<void>((resolve) => {
          capTimer = setTimeout(resolve, this.agentSessionTimeoutMs);
        });
        try {
          await Promise.race([established, cap]);
        } finally {
          if (capTimer) clearTimeout(capTimer);
        }
      })().catch((err) => {
        // Pre-warm unavailable — not fatal, the ladder covers it.
        this.agentSessionPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`ngrok agent pre-warm unavailable, relying on connect retry ladder: ${msg}`);
      });
    }

    await this.agentSessionPromise;
  }

  /** Whether the pre-warm believes the agent session is live (trace/diagnostics). */
  get sessionReady(): boolean {
    return this.agentSessionReady;
  }

  async connect(
    localAddr: string,
    hostname: string,
    token: string,
    _opts: TunnelConnectOptions,
  ): Promise<string> {
    const ngrok = await getNgrok();
    const url = await ngrok.connect({
      proto: 'http' as const,
      addr: localAddr,
      hostname,
      authtoken: token,
    });
    if (!url) {
      throw new Error('ngrok.connect() returned empty URL');
    }
    return url;
  }

  async disconnect(publicUrl: string): Promise<void> {
    const ngrok = await getNgrok();
    await ngrok.disconnect(publicUrl);
  }

  /**
   * The agent-reset the retry ladder does between attempts 1 and 2 — the
   * "agent died" recovery path that used to be the only retried case.
   */
  async resetAfterFailedAttempt(): Promise<void> {
    resetNgrokModule();
    this.initialized = false;
    await this.ensureInitialized();
  }

  /**
   * No ngrok tunnels remain, so the agent process may have exited. Reset the
   * module and init state so the next connect() bootstraps a fresh agent.
   */
  onAllTunnelsStopped(): void {
    resetNgrokModule();
    this.initialized = false;
    this.agentSessionReady = false;
    this.agentSessionPromise = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const ngrok = await getNgrok();
      ngrok.getApi();
    } catch {
      // ignore — let connect surface real errors
    }
    this.initialized = true;
  }
}

export function createNgrokTransport(opts: NgrokTransportOptions = {}): TunnelTransport {
  return new NgrokTransport(opts);
}

export type { NgrokTransport };
