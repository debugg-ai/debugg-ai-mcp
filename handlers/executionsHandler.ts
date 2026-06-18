/**
 * executions tool dispatcher (epic yg7o6, C3).
 * Routes `action` to the existing searchExecutions handler body.
 * (D6 recency sort deferred — backend listExecutions has no ordering param.)
 */
import { ExecutionsInput, ToolContext, ToolResponse } from '../types/index.js';
import { searchExecutionsHandler } from './searchExecutionsHandler.js';

export async function executionsHandler(input: ExecutionsInput, ctx: ToolContext): Promise<ToolResponse> {
  switch (input.action) {
    case 'get':
      return searchExecutionsHandler({ uuid: input.uuid }, ctx);
    case 'list':
      return searchExecutionsHandler({ projectUuid: input.projectUuid, status: input.status, page: input.page, pageSize: input.pageSize }, ctx);
  }
}
