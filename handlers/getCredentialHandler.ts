import { GetCredentialInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'getCredentialHandler' });

function notFound(uuid: string, context: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error: 'NotFound',
      message: `Credential ${uuid} not found (${context}).`,
      uuid,
    }, null, 2) }],
    isError: true,
  };
}

export async function getCredentialHandler(
  input: GetCredentialInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('get_credential', { uuid: input.uuid, environmentId: input.environmentId, projectUuid: input.projectUuid });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) return notFound(input.uuid, 'no git repo and no projectUuid');
      const project = await client.findProjectByRepoName(repoName);
      if (!project) return notFound(input.uuid, `no project for repo "${repoName}"`);
      projectUuid = project.uuid;
    }

    try {
      const credential = await client.getCredential(projectUuid, input.environmentId, input.uuid);
      logger.toolComplete('get_credential', Date.now() - start);
      return { content: [{ type: 'text', text: JSON.stringify({ credential }, null, 2) }] };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) {
        return notFound(input.uuid, `backend 404 for env ${input.environmentId}`);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('get_credential', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'get_credential');
  }
}
