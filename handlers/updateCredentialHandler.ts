import { UpdateCredentialInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'updateCredentialHandler' });

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

// Defensive stripper: ensure no password/secret keys slip through into responses.
function stripSecrets<T extends Record<string, any>>(obj: T): T {
  const copy: Record<string, any> = { ...obj };
  delete copy.password;
  delete copy.secret;
  return copy as T;
}

export async function updateCredentialHandler(
  input: UpdateCredentialInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('update_credential', {
    uuid: input.uuid,
    environmentId: input.environmentId,
    patchKeys: Object.keys(input).filter(k => !['uuid', 'environmentId', 'projectUuid', 'password'].includes(k)).concat(input.password !== undefined ? ['password'] : []),
  });

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
      const credential = await client.updateCredential(projectUuid, input.environmentId, input.uuid, {
        label: input.label,
        username: input.username,
        password: input.password,
        role: input.role,
      });
      logger.toolComplete('update_credential', Date.now() - start);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          updated: true,
          credential: stripSecrets(credential),
        }, null, 2) }],
      };
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.status === 404) {
        return notFound(input.uuid, `backend 404 for env ${input.environmentId}`);
      }
      throw err;
    }
  } catch (error) {
    logger.toolError('update_credential', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'update_credential');
  }
}
