/**
 * test_suite tool dispatcher (epic yg7o6, C3).
 * Routes `action` to existing handler bodies; delete is guarded (D2).
 */
import { TestSuiteInput, ToolContext, ToolResponse } from '../types/index.js';
import { ensureConfirmed } from '../utils/confirmDestructive.js';
import { searchTestSuitesHandler } from './searchTestSuitesHandler.js';
import { createTestSuiteHandler } from './createTestSuiteHandler.js';
import { getTestSuiteResultsHandler } from './getTestSuiteResultsHandler.js';
import { deleteTestSuiteHandler } from './deleteTestSuiteHandler.js';

export async function testSuiteHandler(input: TestSuiteInput, ctx: ToolContext): Promise<ToolResponse> {
  switch (input.action) {
    case 'list': {
      const { action, ...rest } = input;
      return searchTestSuitesHandler(rest, ctx);
    }
    case 'create': {
      const { action, ...rest } = input;
      return createTestSuiteHandler(rest, ctx);
    }
    case 'run':
      // The server no longer has a suite-run route; calling it only yields a raw HTML 404.
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'ActionRetired',
          message: 'test_suite "run" is no longer supported: the DebuggAI server removed suite runs. Use action "results" for existing outcomes, or check_app_in_browser / trigger_crawl to exercise an app.',
        }, null, 2) }],
        isError: true,
      };
    case 'results': {
      const { action, ...rest } = input;
      return getTestSuiteResultsHandler(rest, ctx);
    }
    case 'delete': {
      const label = `test suite ${input.suiteUuid ?? input.suiteName ?? ''}`.trim();
      const refusal = await ensureConfirmed('delete', label, input, ctx);
      if (refusal) return refusal;
      const { action, confirm, ...rest } = input;
      return deleteTestSuiteHandler(rest, ctx);
    }
  }
}
