import { RunTestSuiteInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { TunnelProvisionError } from '../services/tunnels.js';
import { disposeUnhealthyTunnel } from '../utils/tunnelDisposition.js';
import { probeLocalPort, probeTunnelHealth } from '../utils/localReachability.js';
import { extractLocalhostPort } from '../utils/urlParser.js';
import { buildContext, sanitizeResponseUrls, TunnelContext } from '../utils/tunnelContext.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { config } from '../config/index.js';
import { resolveProject, resolveTestSuite } from '../utils/resolveProject.js';

const logger = new Logger({ module: 'runTestSuiteHandler' });

function errorResp(error: string, message: string, extra: Record<string, any> = {}): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }, null, 2) }], isError: true };
}

export async function runTestSuiteHandler(
  input: RunTestSuiteInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('run_test_suite', input);

  const client = new DebuggAIServerClient(config.api.key);
  await client.init();

  let acquiredKeyId: string | null = null;
  let tunnelId: string | undefined;
  // Used ONLY to scope the defensive sanitizeResponseUrls call below (bead
  // debugg_ai_mcp-6cfv.7) — never fed into acquirePortRoute/PortLock. This
  // handler is fire-and-forget (no poll loop, no bounded window to hold the
  // shared session lock over — see the acquireDedicatedTunnel call below), so
  // it deliberately does NOT go through findExistingTunnel/ensureTunnel/
  // acquirePortRoute at all (§2.3's named, deliberate exception).
  let sanitizeCtx: TunnelContext | undefined;

  try {
    let suiteUuid = input.suiteUuid;
    if (!suiteUuid) {
      let projectUuid = input.projectUuid;
      if (!projectUuid) {
        const resolved = await resolveProject(client, input.projectName!);
        if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
        projectUuid = resolved.uuid;
      }
      const resolved = await resolveTestSuite(client, input.suiteName!, projectUuid);
      if ('error' in resolved) return errorResp(resolved.error, resolved.message, { candidates: (resolved as any).candidates });
      suiteUuid = resolved.uuid;
    }

    // Resolve the effective target URL — tunnel if localhost, pass-through otherwise.
    let effectiveTargetUrl = input.targetUrl;

    if (input.targetUrl) {
      const ctx = buildContext(input.targetUrl);

      if (ctx.isLocalhost) {
        const port = extractLocalhostPort(ctx.originalUrl);
        if (typeof port === 'number') {
          const probe = await probeLocalPort(port);
          if (!probe.reachable) {
            return errorResp(
              'LocalServerUnreachable',
              `No server listening on 127.0.0.1:${port}. Start your dev server before running the suite. (${probe.code}: ${probe.detail ?? 'no detail'})`,
              { port, probeCode: probe.code, elapsedMs: probe.elapsedMs },
            );
          }
        }

        if (config.devMode) {
          // Dev mode: local backend can reach localhost directly — no tunnel needed.
          logger.info(`run_test_suite: dev mode — using localhost URL directly: ${input.targetUrl}`);
        } else {
          // §2.3: run_test_suite is the ONE named, deliberate exception to
          // "one tunnel per session" — it is fire-and-forget (dispatches
          // client.runTestSuite() below and returns; the tests it triggers
          // keep using this tunnel on the BACKEND for possibly many more
          // minutes, entirely outside this process's poll loop, because
          // there IS no poll loop). Sharing the session's Caddy-routed tunnel
          // and its PortLock would give this handler no real protection —
          // the lock would release back to contention seconds after
          // triggering a suite that goes on to use the port for much longer.
          // So it gets its OWN tunnel, dialing ngrok directly, bypassing
          // Caddy/PortLock entirely (never deduped/reused — always fresh).
          let tunnel;
          try {
            tunnel = await client.tunnels!.provisionWithRetry();
          } catch (provisionError) {
            const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
            const diag = provisionError instanceof TunnelProvisionError ? ` ${provisionError.diagnosticSuffix()}` : '';
            return errorResp(
              'TunnelProvisionFailed',
              `Failed to provision tunnel for ${input.targetUrl}. (Detail: ${msg})${diag}`,
            );
          }
          acquiredKeyId = tunnel.keyId;

          let dedicated;
          try {
            dedicated = await tunnelManager.acquireDedicatedTunnel(
              ctx.originalUrl,
              tunnel.tunnelKey,
              tunnel.keyId,
              () => client.revokeNgrokKey(tunnel.keyId),
            );
          } catch (tunnelError) {
            const msg = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
            return errorResp('TunnelCreationFailed', `Tunnel creation failed for ${input.targetUrl}. (Detail: ${msg})`);
          }

          // Health probe — catches ERR_NGROK_8012 and bind mismatches before
          // the remote agent wastes steps trying to reach the server.
          if (dedicated.url) {
            const health = await probeTunnelHealth(dedicated.url);
            if (!health.healthy) {
              // Brought in line with the other three handlers, which this one never
              // was (it evicted on EVERY failure and never got bead k34o's shared-
              // registry eviction). Evict only on a code proving the endpoint is
              // gone: a transient edge flake must not cost two billed hours.
              // See utils/tunnelDisposition.ts.
              disposeUnhealthyTunnel({ health, tunnelId: dedicated.tunnelId, originalUrl: ctx.originalUrl });
              // Record the tunnel so the finally block's orphaned-key revoke can't
              // fire: the tunnel we just kept is authenticated with that key, and
              // revoking a live tunnel's credential would kill what we preserved.
              // (On the eviction branch markTunnelDead already revokes it.)
              tunnelId = dedicated.tunnelId;
              return errorResp(
                'TunnelTrafficBlocked',
                `Tunnel established but traffic isn't reaching the dev server. ${health.detail ?? ''}`,
                { code: health.code, ngrokErrorCode: health.ngrokErrorCode, elapsedMs: health.elapsedMs },
              );
            }
          }

          effectiveTargetUrl = dedicated.url;
          tunnelId = dedicated.tunnelId;
          sanitizeCtx = { ...ctx, tunnelId: dedicated.tunnelId, targetUrl: dedicated.url };

          logger.info(`run_test_suite: localhost detected, tunneled ${input.targetUrl} → ${effectiveTargetUrl}`);
        }
      }
    }

    const result = await client.runTestSuite(suiteUuid, { targetUrl: effectiveTargetUrl });
    logger.toolComplete('run_test_suite', Date.now() - start);

    const responsePayload: Record<string, any> = {
      ...result,
      ...(tunnelId ? { tunnelActive: true, originalUrl: input.targetUrl } : {}),
      note: 'Tests are running asynchronously. Use get_test_suite_results to check progress.',
    };

    // Bead debugg_ai_mcp-6cfv.7: this handler previously had NO sanitize call
    // at all — safe only by accident of `result`'s narrow return type never
    // having carried a tunnel hostname in practice. Add the same defensive
    // pass every other handler already runs, so a future backend field that
    // echoes back the (dedicated, ngrok-direct) tunnel URL can never leak it
    // to a caller who only knows their own localhost address.
    const sanitizedPayload = sanitizeCtx ? sanitizeResponseUrls(responsePayload, sanitizeCtx) : responsePayload;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(sanitizedPayload, null, 2),
      }],
    };
  } catch (error) {
    logger.toolError('run_test_suite', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'run_test_suite');
  } finally {
    // Tunnels are NOT torn down — reuse pattern + 55-min idle auto-shutoff.
    // Only revoke an orphaned key (acquired but tunnel creation failed).
    if (acquiredKeyId && !tunnelId) {
      client.revokeNgrokKey(acquiredKeyId).catch((err) =>
        logger.warn(`Failed to revoke unused ngrok key ${acquiredKeyId}: ${err}`),
      );
    }
  }
}
