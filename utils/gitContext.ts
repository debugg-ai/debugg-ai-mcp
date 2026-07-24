/**
 * Auto-detect git repo name from the current working directory.
 * Parses the origin remote URL into "owner/repo" format.
 */

import { execSync } from 'child_process';
import { ProjectAnalyzer } from './projectAnalyzer.js';
import { Logger } from './logger.js';

const logger = new Logger({ module: 'gitContext' });

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
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    cached = parseRepoName(raw);
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The LOCAL git ref of the caller's checkout — the branch + full commit sha the
 * dev server being crawled is actually running. `commitSha` is the full 40-char
 * hash; either field is absent when it can't be read.
 */
export interface LocalGitRef {
  branch?: string;
  commitSha?: string;
}

/**
 * Detect the LOCAL git ref (branch + commit sha) from the current working
 * directory — the repo whose dev server the caller is crawling.
 *
 * sentinal-lwtaw.13 (MCP side): the TRIGGER POINT owns the git fact. The
 * environment says WHERE to crawl; the caller supplies the ref it's running so
 * the backend can mint a git-backed Atlas version. Delegates to
 * ProjectAnalyzer's existing `.git/HEAD` readers — no new git parsing.
 *
 * Best-effort by contract: returns `{}` when cwd isn't a git repo (or the read
 * fails). NEVER throws and NEVER fabricates a branch/sha — a git-less target
 * must still crawl (honest no-git). NOT cached (unlike detectRepoName): the
 * branch/commit change under a long-lived MCP process, so each crawl re-reads.
 */
export async function detectLocalGitRef(): Promise<LocalGitRef> {
  try {
    return await new ProjectAnalyzer().getGitRef(process.cwd());
  } catch (err) {
    logger.debug('Could not determine local git ref', err);
    return {};
  }
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
