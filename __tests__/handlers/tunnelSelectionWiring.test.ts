/**
 * Every handler that opens a tunnel must pass the provision through as the
 * transport selection.
 *
 * Why a source-level test: omitting the argument is silently valid TypeScript
 * (the parameter is optional) and produces a working tunnel — just always an
 * ngrok one, whatever the backend chose, plus a revoke sent to the ngrok
 * endpoint. Every unit test still passes, because each piece works in
 * isolation. check_app_in_browser shipped exactly that way: the flagship tool
 * ignored the debugg transport in production while the other three used it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HANDLERS = [
  'testPageChangesHandler',
  'probePageHandler',
  'triggerCrawlHandler',
  'runTestSuiteHandler',
] as const;

describe('tunnel transport selection is wired through every handler', () => {
  it.each(HANDLERS)('%s passes the provision to the tunnel call', (name) => {
    const src = readFileSync(join(root, 'handlers', `${name}.ts`), 'utf8');
    const call = src.match(/(ensureTunnel|acquireDedicatedTunnel)\(([\s\S]*?)\n\s*\);/);
    expect(call).not.toBeNull();
    // The provision object itself is the last argument.
    expect(call![2]).toMatch(/\btunnel,\s*$/m);
  });

  it.each(HANDLERS)('%s revokes through the transport-aware endpoint', (name) => {
    const src = readFileSync(join(root, 'handlers', `${name}.ts`), 'utf8');
    expect(src).not.toMatch(/revokeNgrokKey\(/);
    expect(src).toMatch(/tunnels!?\.revoke\(/);
  });
});
