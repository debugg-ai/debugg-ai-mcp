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
