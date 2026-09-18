/**
 * Echo check for an environment's authorizedCredentialHosts (bead q4d4).
 *
 * The MCP ships this field before every backend accepts it (sentinal-oj7dp.23).
 * A backend that does not know the field ignores it and still answers 200, so a
 * create/update "succeeds" whether or not the hosts were saved. The only proof
 * is the response echoing them back — so when it doesn't, say so loudly instead
 * of letting the caller believe cross-domain SSO is now configured.
 */

export interface AuthorizedCredentialHostsWarning {
  /** What the caller asked to store. */
  requested: string[];
  /** What the backend echoed back; null when the response had no such field. */
  returned: string[] | null;
  message: string;
}

const norm = (hosts: string[]) => new Set(hosts.map((h) => h.trim().toLowerCase()));

/**
 * Compare the requested hosts with the backend's echo. Returns a warning when
 * they differ (as sets, case-insensitively — the backend normalizes), or
 * undefined when the echo confirms them. `op` shapes the advice: a create has
 * already created the environment, so a retry of create would duplicate it.
 */
export function checkAuthorizedCredentialHostsEcho(
  requested: string[],
  returned: unknown,
  op: 'create' | 'update',
): AuthorizedCredentialHostsWarning | undefined {
  const echoed = Array.isArray(returned) ? (returned as string[]) : null;
  if (echoed) {
    const want = norm(requested);
    const got = norm(echoed);
    if (want.size === got.size && [...want].every((h) => got.has(h))) return undefined;
  }

  const hosts = requested.length > 0 ? requested.join(', ') : '(an empty list)';
  const why = echoed
    ? `The backend did not persist authorizedCredentialHosts as requested: it holds [${echoed.join(', ')}], not [${requested.join(', ')}].`
    : 'The backend did not persist authorizedCredentialHosts: it is not yet supported on this DebuggAI server ' +
      '(the response did not echo the hosts back).';
  const applied = op === 'create'
    ? 'The environment itself WAS created, with any credentials listed here — do not re-run create; ' +
      'set the hosts later with environment {action:"update"}.'
    : 'Everything else in this update was applied.';
  const consequence = requested.length > 0
    ? ` Until the hosts are saved, check_app_in_browser will still refuse to enter credentials on ${hosts} (offscope_host).`
    : '';

  return { requested, returned: echoed, message: `${why} ${applied}${consequence}` };
}
