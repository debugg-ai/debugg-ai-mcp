import {
  UpdateEnvironmentInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'updateEnvironmentHandler' });

function notFound(uuid: string, context: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Environment ${uuid} not found (${context}).`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

type SafeCredential = { uuid: string; label: string; username: string; role: string | null; environmentUuid: string };

function stripPassword(c: any): SafeCredential {
  return {
    uuid: c.uuid,
    label: c.label,
    username: c.username,
    role: c.role ?? null,
    environmentUuid: c.environmentUuid,
  };
}

export async function updateEnvironmentHandler(
  input: UpdateEnvironmentInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('update_environment', {
    uuid: input.uuid,
    hasEnvPatch: !!(input.name || input.url || input.description),
    addCount: input.addCredentials?.length ?? 0,
    updateCount: input.updateCredentials?.length ?? 0,
    removeCount: input.removeCredentialIds?.length ?? 0,
    projectUuid: input.projectUuid,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) return notFound(input.uuid, 'no git repo detected and no projectUuid provided');
      const project = await client.findProjectByRepoName(repoName);
      if (!project) return notFound(input.uuid, `no project found for repo "${repoName}"`);
      projectUuid = project.uuid;
    }

    // ── Env field patch (only if any env field is present) ──────────────────
    const hasEnvPatch = input.name !== undefined || input.url !== undefined || input.description !== undefined;
    let environment: any = null;
    if (hasEnvPatch) {
      try {
        environment = await client.updateEnvironment(projectUuid, input.uuid, {
          name: input.name, url: input.url, description: input.description,
        });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.response?.status === 404) {
          return notFound(input.uuid, `backend returned 404 for project ${projectUuid}`);
        }
        throw err;
      }
    } else {
      // Echo the uuid so the response shape stays consistent. Include projectUuid
      // for downstream tooling. Only populate `environment` if we patched.
      environment = { uuid: input.uuid };
    }

    // ── Cred sub-actions (remove → update → add) ────────────────────────────
    const warnings: Array<{ op: 'add' | 'update' | 'remove'; label?: string; uuid?: string; error: string }> = [];
    const addedCredentials: SafeCredential[] = [];
    const updatedCredentials: SafeCredential[] = [];
    const removedCredentialIds: string[] = [];

    if (input.removeCredentialIds) {
      for (const credUuid of input.removeCredentialIds) {
        try {
          await client.deleteCredential(projectUuid, input.uuid, credUuid);
          removedCredentialIds.push(credUuid);
        } catch (err: any) {
          warnings.push({ op: 'remove', uuid: credUuid, error: err?.message ?? String(err) });
        }
      }
    }

    if (input.updateCredentials) {
      for (const patch of input.updateCredentials) {
        try {
          const updated = await client.updateCredential(
            projectUuid, input.uuid, patch.uuid,
            {
              label: patch.label,
              username: patch.username,
              password: patch.password,
              role: patch.role,
            },
          );
          updatedCredentials.push(stripPassword(updated));
        } catch (err: any) {
          warnings.push({ op: 'update', uuid: patch.uuid, error: err?.message ?? String(err) });
        }
      }
    }

    if (input.addCredentials) {
      for (const seed of input.addCredentials) {
        try {
          const cred = await client.createCredential(projectUuid, input.uuid, {
            label: seed.label,
            username: seed.username,
            password: seed.password,
            role: seed.role,
          });
          addedCredentials.push(stripPassword(cred));
        } catch (err: any) {
          warnings.push({ op: 'add', label: seed.label, error: err?.message ?? String(err) });
        }
      }
    }

    // ── Build response ──────────────────────────────────────────────────────
    const payload: Record<string, any> = {
      updated: hasEnvPatch,
      environment,
    };
    if (addedCredentials.length > 0) payload.addedCredentials = addedCredentials;
    if (updatedCredentials.length > 0) payload.updatedCredentials = updatedCredentials;
    if (removedCredentialIds.length > 0) payload.removedCredentialIds = removedCredentialIds;
    if (warnings.length > 0) payload.credentialWarnings = warnings;

    logger.toolComplete('update_environment', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('update_environment', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'update_environment');
  }
}
