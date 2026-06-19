import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ExecutionsInputSchema, ValidatedTool } from '../types/index.js';
import { executionsHandler } from '../handlers/executionsHandler.js';

const DESCRIPTION = `Look up workflow executions (history of check_app_in_browser, trigger_crawl, and test-suite runs). Pass an "action":
  - "get"  {uuid} → one execution with FULL detail (nodeExecutions, state, errorInfo) + any screenshot/gif artifacts.
  - "list" {projectUuid?, status?, page?, pageSize?} → paginated execution summaries. status ∈ completed|running|failed|cancelled|pending.

Tip: after a fresh check_app_in_browser run, poll action:"get" with the returned executionId until artifact URLs are available.`;

export function buildExecutionsTool(): Tool {
  return {
    name: 'executions',
    title: 'Workflow Executions',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'list'], description: 'Operation to perform.' },
        uuid: { type: 'string', description: '[get] Execution UUID.' },
        projectUuid: { type: 'string', description: '[list] Filter by project UUID.' },
        status: { type: 'string', description: '[list] Filter by status.' },
        page: { type: 'number', description: '[list] Page (1-indexed).' },
        pageSize: { type: 'number', description: '[list] Page size (1..200).' },
      },
      required: ['action'],
      // No top-level oneOf/anyOf/allOf: the Anthropic tool input_schema rejects
      // them and clients (Claude Code) silently drop the tool. Per-action required
      // fields are enforced by the Zod discriminated union in types/index.ts and
      // documented in DESCRIPTION above.
      additionalProperties: false,
    },
  };
}

export function buildValidatedExecutionsTool(): ValidatedTool {
  return { ...buildExecutionsTool(), inputSchema: ExecutionsInputSchema, handler: executionsHandler };
}
