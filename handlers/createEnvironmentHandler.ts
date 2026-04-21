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
          message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from list_projects) or invoke from a directory with a git origin.',
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

    const payload = {
      created: true,
      projectUuid,
      environment: env,
    };

    logger.toolComplete('create_environment', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('create_environment', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_environment');
  }
}
