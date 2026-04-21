import {
  CreateCredentialInput,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';
import { detectRepoName } from '../utils/gitContext.js';

const logger = new Logger({ module: 'createCredentialHandler' });

export async function createCredentialHandler(
  input: CreateCredentialInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_credential', {
    environmentId: input.environmentId,
    label: input.label,
    hasRole: !!input.role,
    projectUuid: input.projectUuid,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    let projectUuid = input.projectUuid;
    if (!projectUuid) {
      const repoName = detectRepoName();
      if (!repoName) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'NoProjectResolved',
            message: 'No git repo detected and no projectUuid provided. Pass projectUuid (get it from list_projects) or invoke from a directory with a git origin.',
          }, null, 2) }],
          isError: true,
        };
      }
      const project = await client.findProjectByRepoName(repoName);
      if (!project) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'NoProjectResolved',
            message: `No DebuggAI project found for repo "${repoName}". Pass projectUuid explicitly.`,
          }, null, 2) }],
          isError: true,
        };
      }
      projectUuid = project.uuid;
    }

    const cred = await client.createCredential(projectUuid, input.environmentId, {
      label: input.label,
      username: input.username,
      password: input.password,
      role: input.role,
    });

    const payload = {
      created: true,
      projectUuid,
      credential: cred,
    };

    logger.toolComplete('create_credential', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('create_credential', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_credential');
  }
}
