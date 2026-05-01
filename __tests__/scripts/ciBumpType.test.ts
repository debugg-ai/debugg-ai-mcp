/**
 * Classifier tests for scripts/ci-bump-type.mjs (bead drn).
 *
 * The pure-function exports (classifyMessage, pickBumpType, highestBump) can
 * be imported directly. getCommitMessages touches git and is covered by the
 * integration commit-push itself, not here.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';

// Lazy dynamic import so we can test the .mjs under jest's ESM setup
// @ts-ignore — resolved at runtime
let classifyMessage: (msg: string) => 'major' | 'minor' | 'patch';
// @ts-ignore
let pickBumpType: (messages: string[]) => 'major' | 'minor' | 'patch';
// @ts-ignore
let highestBump: (types: string[]) => 'major' | 'minor' | 'patch';

beforeAll(async () => {
  // @ts-ignore — jest allows .mjs imports via dynamic import
  const mod = await import('../../scripts/ci-bump-type.mjs');
  classifyMessage = mod.classifyMessage;
  pickBumpType = mod.pickBumpType;
  highestBump = mod.highestBump;
});

describe('classifyMessage', () => {
  test('feat!: → major', () => {
    expect(classifyMessage('feat!: collapse MCP surface 22→11 tools')).toBe('major');
  });

  test('feat(scope)!: → major', () => {
    expect(classifyMessage('feat(tools)!: rename all search_* tools')).toBe('major');
  });

  test('fix!: → major (any type with ! is major)', () => {
    expect(classifyMessage('fix!: change error response shape')).toBe('major');
  });

  test('refactor(api)!: → major', () => {
    expect(classifyMessage('refactor(api)!: drop legacy endpoints')).toBe('major');
  });

  test('BREAKING CHANGE: footer → major', () => {
    const msg = [
      'feat: add new auth flow',
      '',
      'BREAKING CHANGE: tokens are now JWT-formatted instead of opaque strings',
    ].join('\n');
    expect(classifyMessage(msg)).toBe('major');
  });

  test('BREAKING-CHANGE: (hyphen variant) → major', () => {
    const msg = [
      'feat: new auth flow',
      '',
      'BREAKING-CHANGE: tokens now JWT',
    ].join('\n');
    expect(classifyMessage(msg)).toBe('major');
  });

  test('feat: (no !) → minor', () => {
    expect(classifyMessage('feat: add trigger_crawl tool')).toBe('minor');
  });

  test('feat(scope): → minor', () => {
    expect(classifyMessage('feat(browser): support localhost URLs')).toBe('minor');
  });

  test('fix: → patch', () => {
    expect(classifyMessage('fix: null pointer in searchEnvironments')).toBe('patch');
  });

  test('chore: → patch', () => {
    expect(classifyMessage('chore: bump version to 1.0.64')).toBe('patch');
  });

  test('docs: → patch', () => {
    expect(classifyMessage('docs: update README')).toBe('patch');
  });

  test('refactor: → patch', () => {
    expect(classifyMessage('refactor: extract tunnel classifier')).toBe('patch');
  });

  test('no conventional-commits prefix → patch', () => {
    expect(classifyMessage('updates for crawlers')).toBe('patch');
  });

  test('empty string → patch (safe default)', () => {
    expect(classifyMessage('')).toBe('patch');
  });

  test('undefined → patch (safe default)', () => {
    // @ts-ignore — testing defensive handling
    expect(classifyMessage(undefined)).toBe('patch');
  });

  test('BREAKING CHANGE inside quoted body text (not as footer) → still major', () => {
    // Our regex is ^BREAKING\s-CHANGE: with /m flag; it matches at any line start.
    // If someone writes "BREAKING CHANGE:" inside the body or as a footer, that's a
    // breaking change. This is the spec.
    const msg = [
      'fix: touch up tests',
      '',
      'Context:',
      'BREAKING CHANGE: we discussed this in the PR',
    ].join('\n');
    expect(classifyMessage(msg)).toBe('major');
  });

  test('lowercase "breaking change:" (spec requires uppercase) → patch', () => {
    // Per Conventional Commits spec the footer is case-sensitive.
    expect(classifyMessage('fix: stuff\n\nbreaking change: lowercase')).toBe('patch');
  });

  test('feat!: with scope and longer header → major', () => {
    expect(classifyMessage('feat(search)!: return single-object detail on uuid mode')).toBe('major');
  });

  test('! inside the subject but NOT right before the colon → patch', () => {
    // Only the type(scope)!: pattern should match; stray ! elsewhere shouldn't.
    expect(classifyMessage('fix: handle ! in user input')).toBe('patch');
  });
});

describe('highestBump', () => {
  test('major wins over minor and patch', () => {
    expect(highestBump(['patch', 'major', 'minor'])).toBe('major');
  });

  test('minor wins over patch alone', () => {
    expect(highestBump(['patch', 'minor', 'patch'])).toBe('minor');
  });

  test('all patch → patch', () => {
    expect(highestBump(['patch', 'patch'])).toBe('patch');
  });

  test('empty array → patch', () => {
    expect(highestBump([])).toBe('patch');
  });
});

describe('pickBumpType (multi-commit push)', () => {
  test('single feat!: commit → major', () => {
    expect(pickBumpType(['feat!: drop legacy'])).toBe('major');
  });

  test('mix of patch + feat: → minor', () => {
    expect(pickBumpType([
      'chore: whitespace',
      'fix: off-by-one',
      'feat: add new tool',
    ])).toBe('minor');
  });

  test('mix of patch + feat! → major (single breaking change wins)', () => {
    expect(pickBumpType([
      'chore: whitespace',
      'fix: off-by-one',
      'feat!: remove old tools',
    ])).toBe('major');
  });

  test('empty messages → patch (safe default)', () => {
    expect(pickBumpType([])).toBe('patch');
  });

  test('the actual a33f128 commit header would correctly classify as major', () => {
    // Regression check: the commit that caused bead 8bf must now pick major.
    const msg = 'feat!: collapse MCP surface 22→11 tools, defer API-key validation, fix progress race';
    expect(pickBumpType([msg])).toBe('major');
  });
});
