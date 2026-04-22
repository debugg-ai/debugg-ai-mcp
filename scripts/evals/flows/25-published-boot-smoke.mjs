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

async function assertFailsFastWithoutKey(spawnArgs, cwd, writeArtifact, label) {
  const [cmd, ...args] = spawnArgs;
  const env = { ...process.env, LOG_LEVEL: 'error' };
  delete env.DEBUGGAI_API_KEY;

  const p = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  p.stderr.on('data', (c) => stderrChunks.push(c.toString()));

  const exitResult = await Promise.race([
    new Promise((resolve) => p.on('exit', (code) => resolve({ exited: true, code }))),
    new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 10_000)),
  ]);

  const stderr = stderrChunks.join('');
  await writeArtifact(`${label}-missing-key-stderr.txt`, stderr);

  if (!exitResult.exited) {
    try { p.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error(`[${label}] Server did NOT exit within 10s when DEBUGGAI_API_KEY is missing — it hung. This is the "Failed to reconnect" failure mode with no diagnostic. stderr so far:\n${stderr.slice(0, 500)}`);
  }
  if (exitResult.code === 0) {
    throw new Error(`[${label}] Expected non-zero exit when API key missing; got 0. stderr:\n${stderr.slice(0, 500)}`);
  }
  if (!/DEBUGGAI_API_KEY|api\.key|API key/i.test(stderr)) {
    throw new Error(`[${label}] Missing-API-key stderr must mention DEBUGGAI_API_KEY for users to self-diagnose; got:\n${stderr.slice(0, 800)}`);
  }
}

export const flow = {
  name: 'published-boot-smoke',
  tags: ['fast', 'published', 'protocol'],
  description: 'Boot @debugg-ai/debugg-ai-mcp via npx AND direct-node; prove both paths work and both fail fast without DEBUGGAI_API_KEY',
  async run({ step, assert, writeArtifact }) {
    const smokeDir = mkdtempSync(join(tmpdir(), 'debuggai-mcp-smoke-'));
    console.log(`  \x1b[2msmoke dir: ${smokeDir}\x1b[0m`);

    const testConfig = JSON.parse(execSync(`cat ${join(ROOT, 'test-config.json')}`).toString());
    const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
    const ENV_WITH_KEY = { ...process.env, DEBUGGAI_API_KEY: API_KEY, LOG_LEVEL: 'error' };

    try {
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

      await step('npx -y without DEBUGGAI_API_KEY: exits non-zero within 10s with informative stderr', async () => {
        await assertFailsFastWithoutKey(
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

      await step('node dist/index.js without DEBUGGAI_API_KEY: exits non-zero within 10s with informative stderr', async () => {
        await assertFailsFastWithoutKey(
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
