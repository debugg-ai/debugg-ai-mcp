import {
  CreateEnvironmentInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'createEnvironmentHandler' });

export async function createEnvironmentHandler(
  input: CreateEnvironmentInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_environment', {
    name: input.name,
    hasUrl: !!input.url,
    projectUuid: input.projectUuid,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) {
        const payload = {
          error: 'NoProjectResolved',
          message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from search_projects) or invoke from a directory with a git origin.',
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
      }
      const project = await client.findProjectByRepoName(repoName);
      if (!project) {
        const payload = {
          error: 'NoProjectResolved',
          message: `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly.`,
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
      }
      projectUuid = project.uuid;
    }

    const env = await client.createEnvironment(projectUuid, {
      name: input.name,
      url: input.url,
      description: input.description,
    });

    const payload: Record<string, any> = {
      created: true,
      projectUuid,
      environment: env,
    };

    // Optional credentials seed: best-effort per-cred. Success goes to
    // credentials[]; failure goes to credentialWarnings[] (never blocks env creation).
    if (input.credentials && input.credentials.length > 0) {
      const created: Array<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }> = [];
      const warnings: Array<{ label: string; error: string }> = [];
      for (const seed of input.credentials) {
        try {
          const cred = await client.createCredential(projectUuid, env.uuid, {
            label: seed.label,
            username: seed.username,
            password: seed.password,
            role: seed.role,
          });
          // Defensive: drop any stray password from the response shape
          created.push({
            uuid: cred.uuid,
            label: cred.label,
            username: cred.username,
            role: cred.role ?? null,
            environmentUuid: cred.environmentUuid,
          });
        } catch (err: any) {
          warnings.push({
            label: seed.label,
            error: err?.message ?? String(err),
          });
        }
      }
      payload.credentials = created;
      if (warnings.length > 0) payload.credentialWarnings = warnings;
    }

    logger.toolComplete('create_environment', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('create_environment', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_environment');
  }
}
