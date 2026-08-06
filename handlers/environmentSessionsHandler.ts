/**
 * environment sessions handlers (sentinal-cs1hn.5).
 *
 * The backend keeps a warm authenticated session per account and RESTORES it to
 * skip login. That cache silently decides which account a run signs in as, and
 * until these two actions existed it had no surface at all: a run reusing the
 * wrong account's session was indistinguishable from a run that simply found no
 * login form, and the only way to clear one was a shell on the backend.
 *
 *   sessions       → what is held, for whom, and is it still usable
 *   clearSessions  → force the next run to log in for real
 *
 * Neither ever returns session CONTENTS. A session cookie is a bearer credential;
 * the API does not serialize it and this layer never asks for it.
 */
import { EnvironmentInput, ToolContext, ToolResponse } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { config } from '../config/index.js';

const logger = new Logger({ module: 'environmentSessionsHandler' });

type SessionsInput = Extract<EnvironmentInput, { action: 'sessions' }>;
type ClearSessionsInput = Extract<EnvironmentInput, { action: 'clearSessions' }>;

function ok(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export async function listEnvironmentSessionsHandler(
  input: SessionsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  logger.toolStart('environment.sessions', { uuid: input.uuid, username: input.username });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const sessions = await client.listEnvironmentSessions(input.uuid, {
      ...(input.username ? { username: input.username } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    });

    // usableCount, not just the rows: "does this environment currently hold a
    // session that will be restored?" is the question a caller is actually
    // asking, and an expired row still reports status 'valid'.
    const usableCount = sessions.filter(s => s.isUsable).length;
    return ok({
      environmentUuid: input.uuid,
      sessions,
      pageInfo: { totalCount: sessions.length, usableCount },
      note: sessions.length === 0
        ? 'No captured sessions — every run for this environment logs in for real.'
        : `${usableCount} of ${sessions.length} session(s) would be restored instead of logging in. `
          + 'Use action "clearSessions" to force a real login, or pass freshSession:true on a single run.',
    });
  } catch (error) {
    throw handleExternalServiceError(error, 'DebuggAI', 'environment.sessions');
  }
}

export async function clearEnvironmentSessionsHandler(
  input: ClearSessionsInput,
  _context: ToolContext,
): Promise<ToolResponse> {
  logger.toolStart('environment.clearSessions', { uuid: input.uuid, username: input.username });

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    const filters = {
      ...(input.username ? { username: input.username } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
    };
    const { invalidated } = await client.clearEnvironmentSessions(input.uuid, filters);

    const scope = input.username ?? input.credentialId ?? 'all accounts';
    logger.info(`environment.clearSessions: invalidated ${invalidated} session(s) for ${scope}`);
    return ok({
      environmentUuid: input.uuid,
      invalidated,
      scope,
      note: invalidated === 0
        ? 'Nothing to clear — no usable captured session matched.'
        : 'The next run for this identity will perform a real login and re-capture.',
    });
  } catch (error) {
    throw handleExternalServiceError(error, 'DebuggAI', 'environment.clearSessions');
  }
}
