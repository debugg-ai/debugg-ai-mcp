import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListExecutionsInputSchema, ValidatedTool } from '../types/index.js';
import { listExecutionsHandler } from '../handlers/listExecutionsHandler.js';

const DESCRIPTION = `List workflow execution history. Paginated — every response includes pageInfo {page, pageSize, totalCount, totalPages, hasMore}; default pageSize 20, max 200. Optional status filter (e.g. "completed", "running", "failed", "cancelled") passed to backend ?status=. Returns summary shape; use get_execution for full detail on a single uuid.`;

export function buildListExecutionsTool(): Tool {
  return {
    name: 'list_executions',
    title: 'List Workflow Executions',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional: filter by execution status.' },
        page: { type: 'number', description: 'Optional: 1-indexed page number. Default 1.', minimum: 1 },
        pageSize: { type: 'number', description: 'Optional: items per page. Default 20, max 200.', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListExecutionsTool(): ValidatedTool {
  const tool = buildListExecutionsTool();
  return { ...tool, inputSchema: ListExecutionsInputSchema, handler: listExecutionsHandler };
}
