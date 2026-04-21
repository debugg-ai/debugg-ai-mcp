import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CancelExecutionInputSchema, ValidatedTool } from '../types/index.js';
import { cancelExecutionHandler } from '../handlers/cancelExecutionHandler.js';

const DESCRIPTION = `Cancel an in-flight workflow execution by UUID. Returns {cancelled:true, uuid} on success. Returns isError:true + AlreadyCompleted when the execution is already done (backend 409). Returns isError:true + NotFound when uuid doesn't exist.`;

export function buildCancelExecutionTool(): Tool {
  return {
    name: 'cancel_execution',
    title: 'Cancel Workflow Execution',
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

export function buildValidatedCancelExecutionTool(): ValidatedTool {
  const tool = buildCancelExecutionTool();
  return { ...tool, inputSchema: CancelExecutionInputSchema, handler: cancelExecutionHandler };
}
