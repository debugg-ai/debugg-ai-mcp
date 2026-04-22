/**
 * Tunnel reuse across sequential check_app_in_browser calls.
 *
 * With per-call teardown removed (bead vwd), the tunnelManager should reuse
 * the same ngrok subdomain for a second call to the same localhost port
 * instead of tearing down + re-provisioning.
 *
 * Observation: read the file-backed tunnel registry at
 * `$TMPDIR/debugg-ai-tunnels.json`. Production code writes the entry on
 * create, leaves it on reuse, and deletes it on stopTunnel. If tunnelId is
 * identical across both calls, reuse worked.
 *
 * Not tested here: the 55-min auto-shutoff boundary — would require time
 * injection (tracked on bead ah1 as future work).
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LANDMARK_HEADING = 'Tunnel Reuse Eval OK';
const REGISTRY_FILE = join(tmpdir(), 'debugg-ai-tunnels.json');

function readRegistry() {
  if (!existsSync(REGISTRY_FILE)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export const flow = {
  name: 'tunnel-reuse-after-idle',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Second check_app_in_browser to the same localhost port reuses the first tunnel',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><title>Tunnel Reuse Eval</title></head>` +
        `<body><h1 id="heading">${LANDMARK_HEADING}</h1></body></html>`,
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const localUrl = `http://localhost:${port}`;
    console.log(`  \x1b[2mlocal server: ${localUrl} (port ${port})\x1b[0m`);

    let firstEntry;
    let secondEntry;

    try {
      await step(`first check_app_in_browser — provisions a tunnel`, async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description: `The page should display a heading that reads exactly "${LANDMARK_HEADING}".`,
          },
        }, 360_000);
        await writeArtifact('first-call.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.success === true, `First call agent reported failure: ${JSON.stringify(body.outcome).slice(0, 300)}`);

        const reg = readRegistry();
        firstEntry = reg[String(port)];
        await writeArtifact('registry-after-first.json', reg);
        assert(
          firstEntry && typeof firstEntry.tunnelId === 'string',
          `Registry should have an entry for port ${port} after first call; got ${JSON.stringify(reg)}`,
        );
      });

      await step(`second check_app_in_browser — reuses the same tunnel`, async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url: localUrl,
            description: `The page should display a heading that reads exactly "${LANDMARK_HEADING}".`,
          },
        }, 360_000);
        await writeArtifact('second-call.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.success === true, `Second call agent reported failure: ${JSON.stringify(body.outcome).slice(0, 300)}`);

        const reg = readRegistry();
        secondEntry = reg[String(port)];
        await writeArtifact('registry-after-second.json', reg);
        assert(
          secondEntry && typeof secondEntry.tunnelId === 'string',
          `Registry should still have an entry for port ${port} after second call`,
        );
      });

      await step('registry entry is the SAME tunnel (tunnelId + ownerPid unchanged)', async () => {
        assert(
          firstEntry.tunnelId === secondEntry.tunnelId,
          `Expected tunnel reuse; got different tunnelIds: first=${firstEntry.tunnelId} second=${secondEntry.tunnelId}`,
        );
        assert(
          firstEntry.ownerPid === secondEntry.ownerPid,
          `Expected same owner PID; got ${firstEntry.ownerPid} → ${secondEntry.ownerPid}`,
        );
        assert(
          secondEntry.lastAccessedAt >= firstEntry.lastAccessedAt,
          `lastAccessedAt should advance or stay equal; first=${firstEntry.lastAccessedAt} second=${secondEntry.lastAccessedAt}`,
        );
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
