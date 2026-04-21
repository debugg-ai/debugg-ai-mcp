import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { GetExecutionInputSchema, ValidatedTool } from '../types/index.js';
import { getExecutionHandler } from '../handlers/getExecutionHandler.js';

const DESCRIPTION = `Fetch full detail for a single workflow execution. Returns {execution:{uuid,status,state,outcome,startedAt,completedAt,durationMs,nodeExecutions,executionSummary,errorInfo,contextData,...}}. Returns isError:true + NotFound when uuid doesn't exist.`;

export function buildGetExecutionTool(): Tool {
  return {
    name: 'get_execution',
    title: 'Get Execution Detail',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Execution UUID. Required.' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  };
}

export function buildValidatedGetExecutionTool(): ValidatedTool {
  const tool = buildGetExecutionTool();
  return { ...tool, inputSchema: GetExecutionInputSchema, handler: getExecutionHandler };
}
