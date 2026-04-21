import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ListExecutionsInputSchema, ValidatedTool } from '../types/index.js';
import { listExecutionsHandler } from '../handlers/listExecutionsHandler.js';

const DESCRIPTION = `List workflow execution history. Optional status filter (e.g. "completed", "running", "failed", "cancelled") passed to backend ?status=. Optional limit caps the page size (default 10). Returns {count, executions:[{uuid,workflow,status,mode,source,outcome,startedAt,completedAt,durationMs,timestamp}]} — summary shape only. Use get_execution for full detail on a single uuid.`;

export function buildListExecutionsTool(): Tool {
  return {
    name: 'list_executions',
    title: 'List Workflow Executions',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional: filter by execution status.' },
        limit: { type: 'number', description: 'Optional: page size cap.', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedListExecutionsTool(): ValidatedTool {
  const tool = buildListExecutionsTool();
  return { ...tool, inputSchema: ListExecutionsInputSchema, handler: listExecutionsHandler };
}
