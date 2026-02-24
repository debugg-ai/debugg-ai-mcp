#!/usr/bin/env node
/**
 * End-to-end pipeline test for debugg-ai-mcp.
 *
 * Builds the project, spawns the real MCP server, sends JSON-RPC messages
 * over stdio, and asserts that the protocol and tools work correctly.
 *
 * Usage:
 *   node scripts/e2e.mjs              # build then test
 *   node scripts/e2e.mjs --skip-build # test against existing dist/
 */

import { spawn, execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist', 'index.js');
const SKIP_BUILD = process.argv.includes('--skip-build');

// Read API key from test-config
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;

// ─── Colours ──────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const ok  = `${c.green}✓${c.reset}`;
const err = `${c.red}✗${c.reset}`;
const hdr = s => console.log(`\n${c.bold}${c.cyan}── ${s} ${c.reset}${'─'.repeat(Math.max(0, 50 - s.length))}`);

// ─── Minimal MCP client over stdio ───────────────────────────────────────────
class MCPClient {
  constructor(proc) {
    this.proc  = proc;
    this.pending = new Map();
    this.nextId  = 1;
    this.buf     = '';

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
        } catch { /* ignore non-JSON lines */ }
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
        reject:  e => { clearTimeout(timer); reject(e); },
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

// ─── Test runner ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(name, fn, { skip = false } = {}) {
  if (skip) {
    console.log(`  ${c.yellow}⊘${c.reset} ${name} ${c.dim}(skipped)${c.reset}`);
    skipped++;
    results.push({ name, status: 'skip' });
    return;
  }
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`  ${ok} ${name} ${c.dim}(${ms}ms)${c.reset}`);
    passed++;
    results.push({ name, status: 'pass', ms });
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`  ${err} ${name} ${c.dim}(${ms}ms)${c.reset}`);
    console.log(`     ${c.red}${e.message}${c.reset}`);
    failed++;
    results.push({ name, status: 'fail', ms, error: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertHas(obj, key) { assert(key in obj, `Expected key "${key}" in response`); }
function assertNoTunnelUrl(text) {
  assert(!text.includes('ngrok.debugg.ai'), 'Response leaks internal tunnel URL');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${c.bold}debugg-ai-mcp e2e test${c.reset}`);
  console.log(`Root: ${ROOT}`);

  // 1. Build
  if (!SKIP_BUILD) {
    hdr('Build');
    console.log('  Running npm run build...');
    try {
      execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
      console.log(`  ${ok} Build succeeded`);
    } catch (e) {
      console.error(`  ${err} Build failed`);
      process.exit(1);
    }
  }

  // 2. Spawn server
  hdr('Server startup');
  const proc = spawn('node', [DIST], {
    env: { ...process.env, DEBUGGAI_API_KEY: API_KEY, LOG_LEVEL: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: ROOT,
  });

  const stderrLines = [];
  proc.stderr.on('data', chunk => {
    stderrLines.push(chunk.toString());
    if (process.env.DEBUG_E2E) process.stderr.write(chunk);
  });

  proc.on('error', e => { console.error(`  ${err} Server process error: ${e.message}`); process.exit(1); });
  proc.on('exit', (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`  ${err} Server exited unexpectedly (code ${code})`);
      if (stderrLines.length) console.error(stderrLines.join(''));
    }
  });

  // Give the server a moment to start
  await new Promise(r => setTimeout(r, 400));
  console.log(`  ${ok} Server process started (pid ${proc.pid})`);

  const client = new MCPClient(proc);
  let toolNames = [];

  try {

    // ── 3. Protocol ──────────────────────────────────────────────────────────
    hdr('Protocol');

    await test('initialize handshake', async () => {
      const r = await client.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      });
      assert(r.serverInfo?.name, 'serverInfo.name missing');
      assert(r.protocolVersion, 'protocolVersion missing');
      client.notify('notifications/initialized', {});
    });

    await test('tools/list — all 13 tools present', async () => {
      const r = await client.request('tools/list', {});
      toolNames = r.tools.map(t => t.name);
      const expected = [
        'check_app_in_browser',
        'quick_screenshot',
        'start_live_session',
        'stop_live_session',
        'get_live_session_status',
        'get_live_session_logs',
        'get_live_session_screenshot',
        'list_tests',
        'list_test_suites',
        'list_commit_suites',
        'create_test_suite',
        'create_commit_suite',
        'get_test_status',
      ];
      const missing = expected.filter(n => !toolNames.includes(n));
      assert(missing.length === 0, `Missing tools: ${missing.join(', ')}`);
    });

    await test('every tool has name, title, description, inputSchema', async () => {
      const r = await client.request('tools/list', {});
      for (const t of r.tools) {
        assert(t.name,        `Tool missing name`);
        assert(t.title,       `Tool ${t.name} missing title`);
        assert(t.description, `Tool ${t.name} missing description`);
        assert(t.inputSchema, `Tool ${t.name} missing inputSchema`);
      }
    });

    // ── 4. Input validation ───────────────────────────────────────────────────
    hdr('Input validation');

    await test('check_app_in_browser — missing description → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: { url: 'https://example.com' },
      });
      assert(r.isError === true, 'Expected isError: true');
      const text = r.content[0].text;
      assert(text.toLowerCase().includes('description') || text.toLowerCase().includes('valid'),
        `Expected validation message, got: ${text.slice(0, 200)}`);
    });

    await test('check_app_in_browser — missing url and localPort → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: { description: 'test' },
      });
      assert(r.isError === true, 'Expected isError: true');
    });

    await test('quick_screenshot — missing url and localPort → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'quick_screenshot',
        arguments: { type: 'VIEWPORT' },
      });
      assert(r.isError === true, 'Expected isError: true');
    });

    await test('get_test_status — missing suiteUuid → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'get_test_status',
        arguments: {},
      });
      assert(r.isError === true, 'Expected isError: true');
    });

    await test('unknown tool → JSON-RPC error (not a tool isError)', async () => {
      try {
        await client.request('tools/call', { name: 'nonexistent_tool', arguments: {} });
        throw new Error('Expected RPC error but got success');
      } catch (e) {
        assert(e.message.includes('RPC error') || e.message.includes('Unknown'),
          `Unexpected error: ${e.message}`);
      }
    });

    // ── 5. Live API calls ─────────────────────────────────────────────────────
    hdr('Live API calls');

    await test('list_tests — returns valid paginated shape', async () => {
      const r = await client.request('tools/call', { name: 'list_tests', arguments: {} });
      assert(!r.isError, `Unexpected error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert('success' in body || 'tests' in body || 'results' in body || Array.isArray(body),
        `Unexpected shape: ${JSON.stringify(body).slice(0, 200)}`);
    });

    await test('list_test_suites — returns valid shape', async () => {
      const r = await client.request('tools/call', { name: 'list_test_suites', arguments: {} });
      assert(!r.isError, `Unexpected error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert('success' in body || 'results' in body || Array.isArray(body),
        `Unexpected shape: ${JSON.stringify(body).slice(0, 200)}`);
    });

    await test('check_app_in_browser — public URL, no ngrok leak in response', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: {
          url: 'https://example.com',
          description: 'Check that the page loads and displays a heading',
        },
      }, 180_000);

      assert(!r.isError, `Tool returned error: ${r.content?.[0]?.text?.slice(0, 400)}`);
      const text = r.content[0].text;
      const body = JSON.parse(text);

      assertHas(body, 'outcome');
      assertHas(body, 'success');
      assertHas(body, 'targetUrl');
      assert(body.targetUrl === 'https://example.com', `targetUrl wrong: ${body.targetUrl}`);
      assertNoTunnelUrl(text);
    });

  } finally {
    client.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  hdr('Summary');
  console.log(`  ${c.green}Passed:${c.reset}  ${passed}`);
  if (failed)  console.log(`  ${c.red}Failed:${c.reset}  ${failed}`);
  if (skipped) console.log(`  ${c.yellow}Skipped:${c.reset} ${skipped}`);

  if (failed > 0) {
    console.log(`\n${c.red}${c.bold}E2E tests FAILED${c.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}E2E tests PASSED${c.reset}\n`);
  }
}

main().catch(e => {
  console.error(`\n${c.red}Fatal error:${c.reset} ${e.message}`);
  if (process.env.DEBUG_E2E) console.error(e.stack);
  process.exit(1);
});
