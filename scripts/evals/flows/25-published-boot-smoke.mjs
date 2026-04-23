/**
 * Boot smoke test for the PUBLISHED @debugg-ai/debugg-ai-mcp npm package.
 *
 * The ACTUAL production spawn path is:
 *     npx -y @debugg-ai/debugg-ai-mcp
 * (registered by scripts.mcp:global and invoked by Claude Code's MCP client)
 *
 * This flow tests BOTH the npx invocation AND a fallback direct-node invocation,
 * because each catches different publish-time failure modes:
 *
 *   - npx -y ...     → catches bad bin field, missing/wrong shebang, un-chmodded
 *                      dist/index.js, bad symlink resolution, npx cache corruption
 *                      (the thing that manifests to users as "Failed to reconnect
 *                      to debugg-ai" with no diagnostic)
 *   - node dist/...  → catches pure code issues (bad imports, ESM extension bugs)
 *
 * Per path, asserts: boot-with-key succeeds + no-key fails fast with informative
 * stderr.
 *
 * Runs from a tmpdir (cwd != this repo) so npx can't self-shadow against the
 * local package.json — the exact mistake of testing `node dist/` from the repo
 * would miss.
 *
 * The tool roster is NOT asserted — published version may lag main. Only the
 * "boots and speaks MCP" invariant.
 */

import { spawn, execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));

class MCPClient {
  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    proc.stdout.on('data', (chunk) => {
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
            msg.error ? reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
          }
        } catch { /* non-JSON, ignore */ }
      }
    });
  }
  request(method, params = {}, timeout = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout ${timeout}ms waiting for ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  close() {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

async function assertBootsAndInitializes(spawnArgs, env, cwd, writeArtifact, label) {
  const [cmd, ...args] = spawnArgs;
  const proc = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  proc.stderr.on('data', (c) => stderrChunks.push(c.toString()));

  try {
    // Give npx a moment to resolve/fetch/exec the bin
    await new Promise((resolve) => setTimeout(resolve, 800));
    const client = new MCPClient(proc);
    const r = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    }, 30_000).catch((e) => ({ __err: e, stderr: stderrChunks.join('').slice(0, 1500) }));

    await writeArtifact(`${label}-stderr.txt`, stderrChunks.join(''));
    if (r.__err) {
      throw new Error(`[${label}] initialize failed: ${r.__err.message}. stderr:\n${r.stderr}`);
    }
    if (!r.serverInfo?.name) {
      throw new Error(`[${label}] serverInfo.name missing: ${JSON.stringify(r)}`);
    }

    client.notify('notifications/initialized', {});
    const tools = await client.request('tools/list', {}, 10_000);
    if (!Array.isArray(tools.tools) || tools.tools.length === 0) {
      throw new Error(`[${label}] tools/list returned empty roster`);
    }
    await writeArtifact(`${label}-tools-list.json`, tools);
    client.close();
    return r.serverInfo.version;
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Without DEBUGGAI_API_KEY:
 *   - Server MUST start and answer `initialize` (so MCP clients don't show
 *     'Failed to reconnect' with no diagnostic).
 *   - `tools/list` MUST return the normal roster.
 *   - The FIRST tool call MUST return a structured MCP error whose message
 *     clearly mentions DEBUGGAI_API_KEY, so the client surfaces the cause.
 *
 * This replaces the old "exits fast with stderr" behavior — stderr was
 * informative but MCP clients never surface subprocess stderr to users.
 */
async function assertMissingKeyReturnsStructuredError(spawnArgs, cwd, writeArtifact, label) {
  const [cmd, ...args] = spawnArgs;
  const env = { ...process.env, LOG_LEVEL: 'error' };
  delete env.DEBUGGAI_API_KEY;

  const p = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  p.stderr.on('data', (c) => stderrChunks.push(c.toString()));

  try {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const client = new MCPClient(p);

    // 1. initialize must succeed
    const r = await client.request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' },
    }, 15_000);
    if (!r.serverInfo?.name) {
      throw new Error(`[${label}] initialize without API key must still return serverInfo; got: ${JSON.stringify(r)}`);
    }
    client.notify('notifications/initialized', {});

    // 2. tools/list must succeed with the usual roster
    const tools = await client.request('tools/list', {}, 10_000);
    if (!Array.isArray(tools.tools) || tools.tools.length === 0) {
      throw new Error(`[${label}] tools/list without API key must still return roster; got empty`);
    }

    // 3. first tool call must return a structured error mentioning DEBUGGAI_API_KEY.
    //    Use `search_projects` — cheap, no browser agent, no network to backend.
    const toolResp = await client.request('tools/call', {
      name: 'search_projects', arguments: {},
    }, 15_000);
    await writeArtifact(`${label}-missing-key-tool-response.json`, toolResp);

    if (toolResp.isError !== true) {
      throw new Error(`[${label}] tool call with no API key must return isError:true; got: ${JSON.stringify(toolResp).slice(0, 400)}`);
    }
    const bodyText = toolResp.content?.[0]?.text ?? '';
    if (!/DEBUGGAI_API_KEY|api\.key|API key/i.test(bodyText)) {
      throw new Error(
        `[${label}] Missing-API-key tool error must mention DEBUGGAI_API_KEY (this is the "Failed to reconnect" fix — clients surface tool errors, they don't surface stderr). Got: ${bodyText.slice(0, 400)}`,
      );
    }

    client.close();
    return;
  } finally {
    try { p.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

export const flow = {
  name: 'published-boot-smoke',
  tags: ['fast', 'published', 'protocol'],
  description: 'Boot @debugg-ai/debugg-ai-mcp via npx AND direct-node; prove both paths work, and without DEBUGGAI_API_KEY the server runs but tool calls return a structured error (bead cma)',
  async run({ step, assert, writeArtifact }) {
    const smokeDir = mkdtempSync(join(tmpdir(), 'debuggai-mcp-smoke-'));
    console.log(`  \x1b[2msmoke dir: ${smokeDir}\x1b[0m`);

    const testConfig = JSON.parse(execSync(`cat ${join(ROOT, 'test-config.json')}`).toString());
    const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
    const ENV_WITH_KEY = { ...process.env, DEBUGGAI_API_KEY: API_KEY, LOG_LEVEL: 'error' };
    const LOCAL_DIST = join(ROOT, 'dist', 'index.js');

    try {
      // ── Path 0: local dist (tests uncommitted behavior immediately) ──────
      // This lets us validate bead cma (missing-key → structured error) before
      // the published version is rebuilt. Path A/B below still test the npm
      // artifact and will catch any regression between local and published.

      await step('local dist without DEBUGGAI_API_KEY: server runs, tool call returns structured error (locks bead cma against local)', async () => {
        await assertMissingKeyReturnsStructuredError(
          ['node', LOCAL_DIST],
          ROOT,
          writeArtifact,
          'local-dist',
        );
      });

      // ── Path A: npx -y (the actual production spawn path) ────────────────

      await step('npx -y @debugg-ai/debugg-ai-mcp — boot + MCP initialize + tools/list (from non-repo cwd)', async () => {
        const version = await assertBootsAndInitializes(
          ['npx', '-y', '@debugg-ai/debugg-ai-mcp'],
          ENV_WITH_KEY,
          smokeDir,                      // cwd outside this repo, prevents npx self-shadow
          writeArtifact,
          'npx',
        );
        console.log(`  \x1b[2m  published version (via npx): ${version}\x1b[0m`);
      });

      await step('npx -y without DEBUGGAI_API_KEY: server runs, initialize+tools/list work, tool call returns structured error (bead cma)', async () => {
        await assertMissingKeyReturnsStructuredError(
          ['npx', '-y', '@debugg-ai/debugg-ai-mcp'],
          smokeDir,
          writeArtifact,
          'npx',
        );
      });

      // ── Path B: direct node after explicit install ───────────────────────
      // Catches pure code issues in the published dist/ (bad imports, ESM bugs)
      // even if the npx bin/shebang layer is what's broken.

      let serverBinPath;
      await step('npm install then node dist/index.js — boot + MCP initialize + tools/list', async () => {
        writeFileSync(join(smokeDir, 'package.json'), JSON.stringify({ name: 'smoke', version: '0.0.0' }));
        execSync('npm install @debugg-ai/debugg-ai-mcp --silent --no-audit --no-fund', {
          cwd: smokeDir, stdio: 'pipe', timeout: 90_000,
        });
        serverBinPath = join(smokeDir, 'node_modules', '@debugg-ai', 'debugg-ai-mcp', 'dist', 'index.js');
        assert(existsSync(serverBinPath), `published dist/index.js not found at ${serverBinPath}`);

        const pkg = JSON.parse(execSync('cat node_modules/@debugg-ai/debugg-ai-mcp/package.json', { cwd: smokeDir }).toString());
        await writeArtifact('published-manifest.json', {
          version: pkg.version, main: pkg.main, bin: pkg.bin,
          type: pkg.type, files: pkg.files, engines: pkg.engines ?? null,
        });

        const version = await assertBootsAndInitializes(
          ['node', serverBinPath],
          ENV_WITH_KEY,
          smokeDir,
          writeArtifact,
          'direct-node',
        );
        console.log(`  \x1b[2m  published version (via direct node): ${version}\x1b[0m`);
      });

      await step('published manifest has engines.node constraint (locks bead 4b1)', async () => {
        const pkg = JSON.parse(execSync('cat node_modules/@debugg-ai/debugg-ai-mcp/package.json', { cwd: smokeDir }).toString());
        assert(
          pkg.engines && typeof pkg.engines.node === 'string' && pkg.engines.node.length > 0,
          `Published package.json missing engines.node. Installing on unsupported Node silently succeeds and crashes at runtime. ` +
          `Current source sets engines.node = ">=20.20.0"; if this assertion fails, the published version (${pkg.version}) is older than the commit that added it — rerun after CI publishes.`,
        );
        // Effective floor is Node 20.20+ because posthog-node requires it
        assert(
          /20|21|22|23|24/.test(pkg.engines.node) || /\d{2,}/.test(pkg.engines.node),
          `engines.node should pin to Node 18+; got "${pkg.engines.node}"`,
        );
      });

      await step('node dist/index.js without DEBUGGAI_API_KEY: server runs, tool call returns structured error', async () => {
        await assertMissingKeyReturnsStructuredError(
          ['node', serverBinPath],
          smokeDir,
          writeArtifact,
          'direct-node',
        );
      });
    } finally {
      try { rmSync(smokeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};
