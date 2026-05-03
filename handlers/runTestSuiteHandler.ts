import { RunTestSuiteInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { TunnelProvisionError } from '../services/tunnels.js';
import { tunnelManager } from '../services/ngrok/tunnelManager.js';
import { probeLocalPort, probeTunnelHealth } from '../utils/localReachability.js';
import { extractLocalhostPort } from '../utils/urlParser.js';
import { buildContext, findExistingTunnel, ensureTunnel } from '../utils/tunnelContext.js';
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

        // Reuse an existing tunnel for this port if one is already active.
        const reused = findExistingTunnel(ctx);
        if (reused) {
          effectiveTargetUrl = reused.targetUrl ?? input.targetUrl;
          tunnelId = reused.tunnelId;
        } else {
          // Provision a new tunnel.
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

          let tunneled;
          try {
            tunneled = await ensureTunnel(
              ctx,
              tunnel.tunnelKey,
              tunnel.tunnelId,
              tunnel.keyId,
              () => client.revokeNgrokKey(tunnel.keyId),
            );
          } catch (tunnelError) {
            const msg = tunnelError instanceof Error ? tunnelError.message : String(tunnelError);
            return errorResp('TunnelCreationFailed', `Tunnel creation failed for ${input.targetUrl}. (Detail: ${msg})`);
          }

          // Health probe — catches ERR_NGROK_8012 and bind mismatches before
          // the remote agent wastes steps trying to reach the server.
          if (tunneled.targetUrl) {
            const health = await probeTunnelHealth(tunneled.targetUrl);
            if (!health.healthy) {
              if (tunneled.tunnelId) {
                tunnelManager.stopTunnel(tunneled.tunnelId).catch((err) =>
                  logger.warn(`Failed to stop broken tunnel ${tunneled.tunnelId}: ${err}`),
                );
              }
              return errorResp(
                'TunnelTrafficBlocked',
                `Tunnel established but traffic isn't reaching the dev server. ${health.detail ?? ''}`,
                { code: health.code, ngrokErrorCode: health.ngrokErrorCode, elapsedMs: health.elapsedMs },
              );
            }
          }

          effectiveTargetUrl = tunneled.targetUrl ?? input.targetUrl;
          tunnelId = tunneled.tunnelId;
        }

        logger.info(`run_test_suite: localhost detected, tunneled ${input.targetUrl} → ${effectiveTargetUrl}`);
      }
    }

    const result = await client.runTestSuite(suiteUuid, { targetUrl: effectiveTargetUrl });
    logger.toolComplete('run_test_suite', Date.now() - start);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          ...(tunnelId ? { tunnelActive: true, originalUrl: input.targetUrl } : {}),
          note: 'Tests are running asynchronously. Use get_test_suite_results to check progress.',
        }, null, 2),
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
