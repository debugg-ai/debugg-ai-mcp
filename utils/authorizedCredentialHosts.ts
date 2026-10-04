/**
 * Echo check for an environment's authorizedCredentialHosts (bead q4d4).
 *
 * The MCP ships this field before every backend accepts it (sentinal-oj7dp.23).
 * A backend that does not know the field ignores it and still answers 200, so a
 * create/update "succeeds" whether or not the hosts were saved. The only proof
 * is the response echoing them back — so when it doesn't, the response carries
 * the two facts side by side: what was sent, what came back. No prose: the
 * comparison is the whole message.
 */

export interface AuthorizedCredentialHostsWarning {
  /** What the caller asked to store. */
  requested: string[];
  /** What the backend echoed back; null when the response had no such field. */
  returned: string[] | null;
}

const norm = (hosts: string[]) => new Set(hosts.map((h) => h.trim().toLowerCase()));

/**
 * Compare the requested hosts with the backend's echo. Returns the mismatch
 * when they differ (as sets, case-insensitively — the backend normalizes), or
 * undefined when the echo confirms them.
 */
export function checkAuthorizedCredentialHostsEcho(
  requested: string[],
  returned: unknown,
): AuthorizedCredentialHostsWarning | undefined {
  const echoed = Array.isArray(returned) ? (returned as string[]) : null;
  if (echoed) {
    const want = norm(requested);
    const got = norm(echoed);
    if (want.size === got.size && [...want].every((h) => got.has(h))) return undefined;
  }
  return { requested, returned: echoed };
}
