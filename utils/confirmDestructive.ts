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

/**
 * Action names treated as destructive.
 *
 * `clearSessions` is here for BLAST RADIUS, not permanence: invalidating captured
 * sessions is recoverable (the next run logs in and re-captures), but an unscoped
 * clear makes EVERY account on an environment re-authenticate, and that should not
 * happen because a `username` filter was mistyped. The caller-side guard only asks
 * when the call is unscoped — see environmentHandler.
 */
export const DESTRUCTIVE_ACTIONS = new Set(['delete', 'clearSessions']);

export function isDestructiveAction(action: string): boolean {
  return DESTRUCTIVE_ACTIONS.has(action);
}

/**
 * How each destructive action is described when we ask. `delete` keeps its exact
 * pre-existing wording so its behaviour (and tests) are untouched.
 */
const PROMPTS: Record<string, { verb: string; noun: string; consequence: string }> = {
  delete: { verb: 'Delete', noun: 'Deletion', consequence: 'This cannot be undone.' },
  clearSessions: {
    verb: 'Clear all captured login sessions for',
    noun: 'Clearing sessions',
    // Deliberately NOT "cannot be undone" — that would be false, and a guard that
    // overstates the stakes trains people to click through it.
    consequence: 'Every account on it will have to log in again on its next run.',
  },
};

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

  const { verb, noun, consequence } = PROMPTS[action] ?? PROMPTS.delete;

  if (ctx.elicit) {
    const res = await ctx.elicit({
      message: `${verb} ${label}? ${consequence}`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', description: `Confirm: ${verb.toLowerCase()} ${label}` },
        },
        required: ['confirm'],
      },
    });
    if (res.action === 'accept' && res.content?.confirm === true) return null;
    return refusal('confirmation_declined', `${noun} of ${label} was not confirmed.`);
  }

  if (input.confirm === true) return null;
  return refusal(
    'confirmation_required',
    `Refusing to ${verb.toLowerCase()} ${label} without confirmation. `
    + 'Pass confirm:true, or use an elicitation-capable client.',
  );
}
