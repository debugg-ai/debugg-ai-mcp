/**
 * project tool dispatcher (epic yg7o6, C3).
 * Routes the `action` discriminator to the existing per-verb handler bodies.
 * update + delete are intentionally absent (cut, D8 — use the web app).
 */
import { ProjectInput, ToolContext, ToolResponse } from '../types/index.js';
import { searchProjectsHandler } from './searchProjectsHandler.js';
import { createProjectHandler } from './createProjectHandler.js';

export async function projectHandler(input: ProjectInput, ctx: ToolContext): Promise<ToolResponse> {
  switch (input.action) {
    case 'get':
      return searchProjectsHandler({ uuid: input.uuid }, ctx);
    case 'list':
      return searchProjectsHandler({ q: input.q, page: input.page, pageSize: input.pageSize }, ctx);
    case 'create': {
      const { action, ...rest } = input;
      return createProjectHandler(rest, ctx);
    }
  }
}
