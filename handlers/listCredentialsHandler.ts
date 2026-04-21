import {
  ListCredentialsInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'listCredentialsHandler' });

export async function listCredentialsHandler(
  input: ListCredentialsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('list_credentials', {
    environmentId: input.environmentId,
    projectUuid: input.projectUuid,
    q: input.q,
    role: input.role,
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
          message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from list_projects) or invoke from a directory with a git origin.',
          credentials: [],
        };
        logger.toolComplete('list_credentials', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      const project = await client.findProjectByRepoName(repoName);
      if (!project) {
        const payload = {
          error: 'NoProjectResolved',
          message: `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly.`,
          credentials: [],
        };
        logger.toolComplete('list_credentials', Date.now() - start);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
      projectUuid = project.uuid;
    }

    let credentials: Array<{ uuid: string; label: string; username: string; role: string | null; environmentUuid: string }> = [];

    if (input.environmentId) {
      credentials = await client.listCredentialsForEnvironment(
        projectUuid, input.environmentId, input.q, input.role,
      );
    } else {
      // No environment filter — iterate all envs for the project
      const envs = await client.listEnvironmentsForProject(projectUuid);
      for (const env of envs) {
        const credsForEnv = await client.listCredentialsForEnvironment(
          projectUuid, env.uuid, input.q, input.role,
        );
        credentials.push(...credsForEnv);
      }
    }

    const payload = {
      project: { uuid: projectUuid },
      filter: {
        environmentId: input.environmentId ?? null,
        q: input.q ?? null,
        role: input.role ?? null,
      },
      count: credentials.length,
      credentials,
    };

    logger.toolComplete('list_credentials', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('list_credentials', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'list_credentials');
  }
}
