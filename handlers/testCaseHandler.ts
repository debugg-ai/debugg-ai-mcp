/**
 * test_case tool dispatcher (epic yg7o6, C3).
 * Routes `action` to existing handler bodies; delete is guarded (D2).
 */
import { TestCaseInput, ToolContext, ToolResponse } from '../types/index.js';
import { ensureConfirmed } from '../utils/confirmDestructive.js';
import { createTestCaseHandler } from './createTestCaseHandler.js';
import { updateTestCaseHandler } from './updateTestCaseHandler.js';
import { deleteTestCaseHandler } from './deleteTestCaseHandler.js';

export async function testCaseHandler(input: TestCaseInput, ctx: ToolContext): Promise<ToolResponse> {
  switch (input.action) {
    case 'create': {
      const { action, ...rest } = input;
      return createTestCaseHandler(rest, ctx);
    }
    case 'update': {
      const { action, ...rest } = input;
      return updateTestCaseHandler(rest, ctx);
    }
    case 'delete': {
      const refusal = await ensureConfirmed('delete', `test case ${input.testUuid}`, input, ctx);
      if (refusal) return refusal;
      return deleteTestCaseHandler({ testUuid: input.testUuid }, ctx);
    }
  }
}
