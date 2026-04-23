import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SearchExecutionsInputSchema, ValidatedTool } from '../types/index.js';
import { searchExecutionsHandler } from '../handlers/searchExecutionsHandler.js';

const DESCRIPTION = `Search or look up workflow executions (history of check_app_in_browser, trigger_crawl, and other workflow runs).

Two modes:
  - uuid mode: {"uuid": "<execution-uuid>"} → single execution with FULL detail including nodeExecutions, state, errorInfo. NotFound if the uuid doesn't exist.
  - filter mode: {"status": "completed"|"running"|"failed"|"cancelled", "projectUuid": "...", "page", "pageSize"} → paginated summaries.

Response shape: {filter, pageInfo, executions[]}. Summary items have outcome/status/durationMs/timestamps; uuid-mode items additionally have nodeExecutions + state + errorInfo.`;

export function buildSearchExecutionsTool(): Tool {
  return {
    name: 'search_executions',
    title: 'Search Workflow Executions',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Execution UUID. Returns single execution with full detail. Mutually exclusive with projectUuid/status filters.' },
        projectUuid: { type: 'string', description: 'Filter by project UUID.' },
        status: { type: 'string', description: 'Filter by status: completed | running | failed | cancelled | pending.' },
        page: { type: 'number', description: 'Page number (1-indexed).' },
        pageSize: { type: 'number', description: 'Page size (1..200). Default 20.' },
      },
      additionalProperties: false,
    },
  };
}

export function buildValidatedSearchExecutionsTool(): ValidatedTool {
  const tool = buildSearchExecutionsTool();
  return { ...tool, inputSchema: SearchExecutionsInputSchema, handler: searchExecutionsHandler };
}
