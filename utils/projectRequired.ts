/**
 * Shared ProjectRequired text (platform-y2ob.2): says what was observed and
 * what to pass. Used by check_app_in_browser and trigger_crawl.
 */
export function projectRequiredMessage(repoName?: string | null): string {
  const observed = repoName
    ? `Could not determine the DebuggAI project: no project is linked to git repo "${repoName}".`
    : 'Could not determine the DebuggAI project: this is not a git repo and no repoName was passed.';
  return observed
    + ' Pass `projectUuid` (list yours with the `project` tool, action "list") or `repoName` (the "org/repo" of a linked project).';
}

/**
 * A repo->project lookup that FAILED (platform-y2ob.4), as opposed to one that
 * succeeded and found nothing. Only the latter may say "not linked": a 405 or a
 * network error says nothing about whether a project exists. Reports the HTTP
 * status and the backend's message verbatim.
 */
export function projectLookupFailedPayload(repoName: string, err: unknown) {
  const e = err as { statusCode?: number; networkCode?: string; message?: string } | null;
  const statusCode = typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  const reason = err instanceof Error ? err.message : String(err);
  const how = statusCode !== undefined
    ? `HTTP ${statusCode}: ${reason}`
    : `${e?.networkCode ? `${e.networkCode}: ` : ''}${reason}`;
  return {
    error: 'ProjectLookupFailed',
    message: `Could not look up the DebuggAI project for git repo "${repoName}" (${how}). `
      + 'This is a lookup failure, not a missing link: pass `projectUuid` to skip the lookup, or fix the connection and retry.',
    detail: { repoName, ...(statusCode !== undefined ? { statusCode } : {}), ...(e?.networkCode ? { networkCode: e.networkCode } : {}) },
  };
}
