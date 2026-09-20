/**
 * Every handler that opens a tunnel must pass the provision through as the
 * transport selection.
 *
 * Why a source-level test: omitting the argument is silently valid TypeScript
 * (the parameter is optional), so the tunnel call compiles and every unit test
 * still passes, because each piece works in isolation — while in production the
 * transport gets no relayUrl, no tunnelDomain and not the backend's tunnelId.
 * check_app_in_browser shipped exactly that way: the flagship tool ignored the
 * provision while the other three used it.
 *
 * `revokeNgrokKey` is gone from the client, so the second assertion below is a
 * tombstone: it stops the method being reintroduced along with the endpoint.
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
