/**
 * Auto-detect git repo name from the current working directory.
 * Parses the origin remote URL into "owner/repo" format.
 */

import { execSync } from 'child_process';

let cached: string | null | undefined; // undefined = not yet checked

/**
 * Detect the repo name (e.g. "debugg-ai/debugg-ai-frontend") from git remote origin.
 * Returns null if not inside a git repo or no origin is configured.
 * Result is cached for the process lifetime.
 */
export function detectRepoName(): string | null {
  if (cached !== undefined) return cached;

  try {
    const raw = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    cached = parseRepoName(raw);
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Parse an origin URL into "owner/repo" format.
 * Handles SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git).
 */
function parseRepoName(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  return null;
}
