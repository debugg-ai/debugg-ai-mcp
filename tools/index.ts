import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ValidatedTool } from '../types/index.js';
import { buildTestPageChangesTool, buildValidatedTestPageChangesTool } from './testPageChanges.js';
import { buildTriggerCrawlTool, buildValidatedTriggerCrawlTool } from './triggerCrawl.js';
import { buildProbePageTool, buildValidatedProbePageTool } from './probePage.js';
import { buildProjectTool, buildValidatedProjectTool } from './project.js';
import { buildEnvironmentTool, buildValidatedEnvironmentTool } from './environment.js';
import { buildExecutionsTool, buildValidatedExecutionsTool } from './executions.js';
import { buildTestSuiteTool, buildValidatedTestSuiteTool } from './testSuite.js';
import { buildTestCaseTool, buildValidatedTestCaseTool } from './testCase.js';
import { ProjectContext, resolveProjectContext } from '../services/projectContext.js';

let _tools: Tool[] | null = null;
let _validatedTools: ValidatedTool[] | null = null;
const toolRegistry = new Map<string, ValidatedTool>();

let enrichmentTriggered = false;

/**
 * Lazily resolve project → environments → credential labels ON FIRST USE and
 * rebuild the tool definitions so the enriched description (available
 * environments + credential labels) is served on the next tools/list.
 *
 * Fire-and-forget: this never blocks the triggering call. resolveProjectContext
 * has its own 10s timeout, so boot and the first tool call are never gated on a
 * slow backend. Idempotent — the first invocation wins; the cached context
 * makes subsequent resolves free.
 */
function triggerEnrichmentOnce(): void {
  if (enrichmentTriggered) return;
  enrichmentTriggered = true;
  resolveProjectContext()
    .then((ctx) => {
      // Only rebuild when we actually resolved a linked project; otherwise the
      // base description stays (no project detected / not linked).
      if (ctx) initTools(ctx);
    })
    .catch(() => {
      // Best-effort enrichment — a failure leaves the base description in place.
    });
}

/**
 * Initialize tools with project context (call once after resolveProjectContext).
 *
 * The surface is 8 action-based tools (epic yg7o6): 3 browser tools plus one
 * tool per managed entity (project/environment/test_suite/test_case/executions),
 * each routing an `action` discriminator to its handler.
 */
export function initTools(ctx: ProjectContext | null): void {
  const tools: Tool[] = [
    buildTestPageChangesTool(ctx),
    buildProbePageTool(),
    buildTriggerCrawlTool(ctx),
    buildProjectTool(),
    buildEnvironmentTool(),
    buildTestSuiteTool(),
    buildTestCaseTool(),
    buildExecutionsTool(),
  ];
  const validated: ValidatedTool[] = [
    buildValidatedTestPageChangesTool(ctx),
    buildValidatedProbePageTool(),
    buildValidatedTriggerCrawlTool(ctx),
    buildValidatedProjectTool(),
    buildValidatedEnvironmentTool(),
    buildValidatedTestSuiteTool(),
    buildValidatedTestCaseTool(),
    buildValidatedExecutionsTool(),
  ];

  _tools = tools;
  _validatedTools = validated;

  toolRegistry.clear();
  for (const v of validated) toolRegistry.set(v.name, v);
}

export function getTools(): Tool[] {
  if (!_tools) initTools(null);
  triggerEnrichmentOnce();
  return _tools!;
}

export function getTool(name: string): ValidatedTool | undefined {
  if (!_validatedTools) initTools(null);
  triggerEnrichmentOnce();
  return toolRegistry.get(name);
}
