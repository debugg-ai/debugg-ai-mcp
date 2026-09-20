/**
 * The ngrok client is gone, and stays gone.
 *
 * The debugg tunnel server replaced it end to end, so nothing this package
 * ships may import the `ngrok` package, depend on it, or carry a file named
 * after it. That is a STATIC property of the tree, not a runtime one: a stray
 * `await import('ngrok')` on a rarely-taken branch type-checks, passes every
 * unit test that mocks it, and only shows up on a user's machine as a surprise
 * binary download. So this walks the shipped source instead of exercising it.
 *
 * Scope: everything tsconfig.json compiles into dist/ (i.e. the tree minus
 * node_modules, dist and __tests__). Documentation, CHANGELOG and the eval
 * scripts are deliberately out of scope — history is allowed to mention ngrok;
 * the shipped client is not.
 *
 * DELIBERATELY NOT a blanket search for the string "ngrok". Two keeps are
 * load-bearing and must not trip this:
 *   - utils/tunnelDomains.ts still recognises `*.ngrok.debugg.ai`, so a URL
 *     from a historical run is still scrubbed out of tool output
 *     (locked by the positive test in __tests__/utils/tunnelDomains.test.ts).
 *   - utils/imageUtils.ts skips hosts matching /ngrok|tunnel/i.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Mirrors tsconfig.json's `exclude`, plus the non-shipped asset trees. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '__tests__',
  '.git',
  'docs',
  'reference-usages',
  'assets',
  'scripts',
  'e2e-agents',
  '.beads',
  '.rc',
  '.serena',
  '.claude',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = walk(root);
const tsSources = sourceFiles.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

describe('the ngrok client is not part of the shipped surface', () => {
  test('package.json declares no ngrok dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const deps = pkg[field] ?? {};
      expect(Object.keys(deps)).not.toContain('ngrok');
    }
  });

  test('no source file imports the ngrok package', () => {
    // Covers `import x from 'ngrok'`, `from 'ngrok/foo.js'`, `import('ngrok')`,
    // `require('ngrok')` and `require.resolve('ngrok')` — the deep-require form
    // ngrokAgentSession.ts used is the one a naive `import` grep would miss.
    const importsNgrok = /(?:from|import|require|require\.resolve)\s*\(?\s*['"]ngrok(?:\/[^'"]*)?['"]/;
    const offenders = tsSources.filter((file) => importsNgrok.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  test('no shipped file is named after ngrok', () => {
    const offenders = sourceFiles.filter((f) => /ngrok/i.test(relative(root, f)));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  test('no source file still handles ERR_NGROK_* markers', () => {
    // The debugg tunnel server serves DEBUGG_TUNNEL_* instead, and no client
    // that reaches this code can create a tunnel that answers with ERR_NGROK_*.
    // Matching a live code path against them is dead logic that reads as live.
    const offenders = tsSources.filter((file) => /ERR_NGROK/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  test('nothing calls the backend ngrok revoke endpoint', () => {
    const offenders = tsSources.filter((file) => /api\/v1\/ngrok\//.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
});
