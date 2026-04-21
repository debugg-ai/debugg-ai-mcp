/**
 * N independent MCP server processes, each spawned from a DIFFERENT cwd
 * (temporary fake git repo with a unique origin remote), each receiving its
 * own check_app_in_browser call against its own localhost port — all
 * concurrently.
 *
 * This exercises:
 *   - Tunnel isolation across MCP server processes on the same machine
 *   - Project-context independence (each cwd resolves differently)
 *   - Concurrent ngrok provisioning under the same API key
 *   - No cross-wiring: instance A's response must not contain instance B's
 *     marker, and targetUrl must echo the exact URL that was sent to A.
 *
 * Note: the runner's own MCP server (from scripts/evals/runner.mjs) is idle
 * during this flow; we spawn auxiliary MCPs and drive them directly.
 */

import { spawn, execSync } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));
const DIST = join(ROOT, 'dist', 'index.js');
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;

const N_INSTANCES = 2;

// Minimal MCPClient — mirrors scripts/evals/runner.mjs so this flow can
// spawn its own auxiliary MCPs without tangling the runner's state.
class MCPClient {
  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    proc.stdout.on('data', chunk => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            msg.error ? reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
          }
        } catch { /* non-JSON */ }
      }
    });
  }
  _send(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method, params = {}, timeout = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout (${timeout}ms) waiting for ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: r => { clearTimeout(timer); resolve(r); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params = {}) { this._send({ jsonrpc: '2.0', method, params }); }
  close() {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

function makeMarkerServer(marker) {
  return createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!DOCTYPE html><html><head><title>${marker}</title></head>` +
      `<body><h1 id="marker">${marker}</h1>` +
      `<p>If the remote browser reads this, this MCP's tunnel was routed correctly.</p>` +
      `</body></html>`
    );
  });
}

function makeFakeRepo(tag) {
  const dir = mkdtempSync(join(tmpdir(), `mcp-eval-${tag}-`));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "eval@mcp.local"', { cwd: dir });
  execSync('git config user.name "mcp-eval"', { cwd: dir });
  execSync(`git remote add origin https://github.com/mcp-eval/fake-${tag}.git`, { cwd: dir });
  return dir;
}

async function spawnAuxMCP(cwd) {
  const proc = spawn('node', [DIST], {
    env: { ...process.env, DEBUGGAI_API_KEY: API_KEY, LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });
  const stderrChunks = [];
  proc.stderr.on('data', c => stderrChunks.push(c.toString()));
  await new Promise(resolve => setTimeout(resolve, 500));
  const client = new MCPClient(proc);
  const r = await client.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mcp-eval-aux', version: '1.0.0' },
  }, 10_000);
  if (!r.serverInfo?.name) {
    throw new Error(`aux MCP (${cwd}) init failed — stderr: ${stderrChunks.join('').slice(0, 400)}`);
  }
  client.notify('notifications/initialized', {});
  return { proc, client, stderrChunks };
}

export const flow = {
  name: 'multi-mcp-tunnel-contention',
  description: `${N_INSTANCES} independent MCP servers from distinct cwds; concurrent check_app_in_browser with no cross-wiring`,
  async run({ step, assert, writeArtifact }) {
    const ts = Date.now();
    const instances = [];

    for (let i = 0; i < N_INSTANCES; i++) {
      const marker = `MultiMCP-${ts}-${i}`;
      const server = makeMarkerServer(marker);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://localhost:${server.address().port}`;
      const dir = makeFakeRepo(`${i}-${ts}`);
      console.log(`  \x1b[2minstance ${i}: target=${url} cwd=${dir}\x1b[0m`);
      instances.push({ idx: i, marker, url, server, dir, mcp: null });
    }

    try {
      await step(`spawn ${N_INSTANCES} auxiliary MCP servers from distinct cwds`, async () => {
        for (const inst of instances) {
          inst.mcp = await spawnAuxMCP(inst.dir);
        }
      });

      await step(`${N_INSTANCES} concurrent check_app_in_browser — each MCP hits its own target, no cross-wiring`, async () => {
        const promises = instances.map(inst =>
          inst.mcp.client.request('tools/call', {
            name: 'check_app_in_browser',
            arguments: {
              url: inst.url,
              description: `Verify the page displays a heading that reads exactly "${inst.marker}".`,
            },
          }, 300_000).then(response => ({ inst, response }))
        );
        const results = await Promise.all(promises);

        await writeArtifact('summary.json', {
          n: N_INSTANCES,
          perInstance: results.map(({ inst, response }) => {
            const text = response.content?.[0]?.text ?? '';
            let body; try { body = JSON.parse(text); } catch { body = null; }
            return {
              idx: inst.idx,
              marker: inst.marker,
              targetUrl: inst.url,
              cwd: inst.dir,
              isError: !!response.isError,
              success: body?.success,
              echoedTargetUrl: body?.targetUrl,
              stepsTaken: body?.stepsTaken,
            };
          }),
        });

        const otherMarkers = (self) => instances.filter(i => i.marker !== self).map(i => i.marker);

        for (const { inst, response } of results) {
          assert(!response.isError, `Instance ${inst.idx} (${inst.marker}): ${response.content?.[0]?.text?.slice(0, 400)}`);
          const text = response.content[0].text;
          assert(!text.includes('ngrok.debugg.ai'), `Instance ${inst.idx}: tunnel URL leak`);

          const body = JSON.parse(text);
          assert(body.targetUrl === inst.url,
            `Instance ${inst.idx}: targetUrl cross-wired. Expected ${inst.url}, got ${body.targetUrl}`);
          assert(body.success === true,
            `Instance ${inst.idx} (${inst.marker}): agent did not succeed. outcome=${JSON.stringify(body.outcome).slice(0, 200)}`);

          for (const other of otherMarkers(inst.marker)) {
            assert(!text.includes(other),
              `Instance ${inst.idx} response contains another instance's marker: ${other}`);
          }
        }
      });
    } finally {
      for (const inst of instances) {
        try { inst.mcp?.client?.close(); } catch { /* ignore */ }
        try { await new Promise(resolve => inst.server.close(resolve)); } catch { /* ignore */ }
        // Temp dirs are under /tmp — OS cleans them up. Intentionally leave
        // them for post-mortem debugging of failed runs.
      }
    }
  },
};
