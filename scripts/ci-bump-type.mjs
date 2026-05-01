#!/usr/bin/env node
/**
 * Determines semver bump type (major/minor/patch) from the commit messages
 * in a push. Used by .github/workflows/publish.yml to pick the right
 * `npm version <type>` call instead of hardcoding `patch`.
 *
 * Bead drn fix: previously the publish workflow ALWAYS ran `npm version patch`,
 * which stripped the major-bump intent of `feat!:` commits (bead 8bf root cause).
 *
 * Classification rules (per Conventional Commits):
 *   - Any commit with `!:` before the colon in the header (e.g. `feat!:`, `fix!:`,
 *     `refactor(scope)!:`) → major
 *   - Any commit with a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer → major
 *   - `feat:` or `feat(scope):` (without `!`) → minor
 *   - Everything else → patch
 *
 * When multiple commits are in a single push, the highest-priority bump wins
 * (major > minor > patch).
 *
 * Usage:
 *   node scripts/ci-bump-type.mjs             # uses GITHUB_EVENT_BEFORE / GITHUB_SHA
 *   node scripts/ci-bump-type.mjs HEAD~3 HEAD # explicit range
 *
 * Prints one word to stdout: major | minor | patch
 */

import { execSync } from 'node:child_process';

const NULL_SHA = '0000000000000000000000000000000000000000';

export function classifyMessage(msg) {
  if (!msg || typeof msg !== 'string') return 'patch';

  // BREAKING CHANGE footer anywhere in the body (any line)
  // Matches "BREAKING CHANGE:" or "BREAKING-CHANGE:" per spec
  if (/^BREAKING[\s-]CHANGE:/m.test(msg)) return 'major';

  // Inspect only the subject line for type/!/feat: prefix
  const firstLine = msg.split('\n', 1)[0].trim();

  // Conventional Commits marker: `<type>(<scope>)?!:`
  // Examples: feat!:, fix!:, refactor(api)!:, feat(tools)!:
  if (/^[a-zA-Z]+(\([^)]+\))?!:/.test(firstLine)) return 'major';

  // feat: or feat(scope): → minor
  if (/^feat(\([^)]+\))?:/i.test(firstLine)) return 'minor';

  return 'patch';
}

export function highestBump(types) {
  if (types.includes('major')) return 'major';
  if (types.includes('minor')) return 'minor';
  return 'patch';
}

export function getCommitMessages(from, to) {
  // Fallback: if from is missing or the zero-SHA (fresh branch push), inspect
  // HEAD only. Trying to diff from zero-SHA will error.
  if (!from || from === NULL_SHA) {
    const head = execSync(`git log -1 --format=%B ${to || 'HEAD'}`, { encoding: 'utf8' });
    return [head.trim()].filter(Boolean);
  }

  try {
    // NUL-delimited so newlines inside commit bodies don't split messages
    const raw = execSync(`git log ${from}..${to} --format=%B%x00`, { encoding: 'utf8' });
    return raw.split('\0').map((s) => s.trim()).filter(Boolean);
  } catch {
    // Range invalid (e.g. force-pushed history) — fall back to HEAD
    const head = execSync(`git log -1 --format=%B ${to || 'HEAD'}`, { encoding: 'utf8' });
    return [head.trim()].filter(Boolean);
  }
}

export function pickBumpType(messages) {
  if (!messages || messages.length === 0) return 'patch';
  const types = messages.map(classifyMessage);
  return highestBump(types);
}

function main() {
  const [, , argFrom, argTo] = process.argv;
  const from = argFrom || process.env.GITHUB_EVENT_BEFORE;
  const to = argTo || process.env.GITHUB_SHA || 'HEAD';
  const messages = getCommitMessages(from, to);
  const bump = pickBumpType(messages);
  process.stdout.write(bump);
}

// Only run main when invoked directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
