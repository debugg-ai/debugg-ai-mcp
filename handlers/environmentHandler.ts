/**
 * environment tool dispatcher (epic yg7o6, C3).
 * Routes `action` to existing handler bodies; delete is guarded (D2).
 */
import { EnvironmentInput, ToolContext, ToolResponse } from '../types/index.js';
import { ensureConfirmed } from '../utils/confirmDestructive.js';
import { searchEnvironmentsHandler } from './searchEnvironmentsHandler.js';
import { createEnvironmentHandler } from './createEnvironmentHandler.js';
import { updateEnvironmentHandler } from './updateEnvironmentHandler.js';
import { deleteEnvironmentHandler } from './deleteEnvironmentHandler.js';

export async function environmentHandler(input: EnvironmentInput, ctx: ToolContext): Promise<ToolResponse> {
  switch (input.action) {
    case 'get':
      return searchEnvironmentsHandler({ uuid: input.uuid, projectUuid: input.projectUuid }, ctx);
    case 'list':
      return searchEnvironmentsHandler({ projectUuid: input.projectUuid, q: input.q, page: input.page, pageSize: input.pageSize }, ctx);
    case 'create': {
      const { action, ...rest } = input;
      return createEnvironmentHandler(rest, ctx);
    }
    case 'update': {
      const { action, ...rest } = input;
      return updateEnvironmentHandler(rest, ctx);
    }
    case 'delete': {
      const refusal = await ensureConfirmed('delete', `environment ${input.uuid}`, input, ctx);
      if (refusal) return refusal;
      return deleteEnvironmentHandler({ uuid: input.uuid, projectUuid: input.projectUuid }, ctx);
    }
  }
}
