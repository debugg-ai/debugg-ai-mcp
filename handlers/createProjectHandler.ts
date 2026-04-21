import { CreateProjectInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'createProjectHandler' });

export async function createProjectHandler(
  input: CreateProjectInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  const start = Date.now();
  logger.toolStart('create_project', {
    name: input.name,
    platform: input.platform,
    teamUuid: input.teamUuid,
    repoUuid: input.repoUuid,
  });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const project = await client.createProject({
      name: input.name,
      platform: input.platform,
      teamUuid: input.teamUuid,
      repoUuid: input.repoUuid,
    });

    const payload = { created: true, project };

    logger.toolComplete('create_project', Date.now() - start);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    logger.toolError('create_project', error as Error, Date.now() - start);
    throw handleExternalServiceError(error, 'DebuggAI', 'create_project');
  }
}
