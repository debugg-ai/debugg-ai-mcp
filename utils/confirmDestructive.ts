/**
 * Destructive-action guard (epic debugg_ai_mcp-yg7o6, decision D2).
 *
 * Consolidated entity tools expose a `delete` action. Before any delete runs we
 * require confirmation:
 *   - If the client supports elicitation (ctx.elicit present), prompt for it.
 *   - Otherwise fall back to a required `confirm: true` argument.
 *
 * This keeps deletes safe on EVERY client without depending on the elicitation
 * epic — that epic only has to populate `ctx.elicit`; the confirm-arg path here
 * ships standalone.
 */

import { ToolContext, ToolResponse } from '../types/index.js';

/** Action names treated as destructive. Currently just `delete`. */
export const DESTRUCTIVE_ACTIONS = new Set(['delete']);

export function isDestructiveAction(action: string): boolean {
  return DESTRUCTIVE_ACTIONS.has(action);
}

function refusal(error: string, message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }],
    isError: true,
  };
}

/**
 * Gate a destructive action.
 *
 * @returns `null` to proceed, or a `ToolResponse` (isError) to abort the call.
 */
export async function ensureConfirmed(
  action: string,
  label: string,
  input: { confirm?: boolean },
  ctx: ToolContext,
): Promise<ToolResponse | null> {
  if (!isDestructiveAction(action)) return null;

  if (ctx.elicit) {
    const res = await ctx.elicit({
      message: `Delete ${label}? This cannot be undone.`,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', description: 'Confirm deletion of ' + label } },
        required: ['confirm'],
      },
    });
    if (res.action === 'accept' && res.content?.confirm === true) return null;
    return refusal('confirmation_declined', `Deletion of ${label} was not confirmed.`);
  }

  if (input.confirm === true) return null;
  return refusal(
    'confirmation_required',
    `Refusing to delete ${label} without confirmation. Pass confirm:true, or use an elicitation-capable client.`,
  );
}
