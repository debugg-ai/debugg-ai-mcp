import { DeleteCredentialInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'deleteCredentialHandler' });

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

export async function deleteCredentialHandler(
  input: DeleteCredentialInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('delete_credential', { uuid: input.uuid, environmentId: input.environmentId });

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
      await client.deleteCredential(projectUuid, input.environmentId, input.uuid);
      logger.toolComplete('delete_credential', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({ deleted: true, uuid: input.uuid }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) {
        return notFound(input.uuid, `backend 404 for env ${input.environmentId}`);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('delete_credential', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'delete_credential');
  }
}
