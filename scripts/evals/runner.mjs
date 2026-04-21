#!/usr/bin/env node
/**
 * Eval runner for debugg-ai-mcp.
 *
 * Discovers flows in ./flows/*.mjs, runs them against a real MCP server
 * spawned over stdio, writes artifacts per flow, and emits pass/fail.
 *
 * Usage:
 *   node scripts/evals/runner.mjs                    # build, run all flows
 *   node scripts/evals/runner.mjs --skip-build       # skip tsc build
 *   node scripts/evals/runner.mjs --flow=protocol    # run one flow
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const DIST = join(ROOT, 'dist', 'index.js');
const FLOWS_DIR = join(HERE, 'flows');
const ARTIFACTS_ROOT = join(HERE, 'artifacts');

const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes('--skip-build');
const FLOW_FILTER = argv.find(a => a.startsWith('--flow='))?.slice('--flow='.length) ?? null;

const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m',
};
const ok  = `${c.green}✓${c.reset}`;
const bad = `${c.red}✗${c.reset}`;
const skp = `${c.yellow}⊘${c.reset}`;
const hdr = s => console.log(`\n${c.bold}${c.cyan}── ${s} ${c.reset}${'─'.repeat(Math.max(0, 60 - s.length))}`);

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

function makeFlowContext({ client, flowDir }) {
  const steps = [];
  return {
    client,
    env: process.env,
    async step(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        const ms = Date.now() - t0;
        console.log(`  ${ok} ${name} ${c.dim}(${ms}ms)${c.reset}`);
        steps.push({ name, status: 'pass', ms });
      } catch (e) {
        const ms = Date.now() - t0;
        console.log(`  ${bad} ${name} ${c.dim}(${ms}ms)${c.reset}`);
        console.log(`     ${c.red}${e.message}${c.reset}`);
        steps.push({ name, status: 'fail', ms, error: e.message });
      }
    },
    assert(cond, msg) { if (!cond) throw new Error(msg); },
    assertHas(obj, key) { if (!(key in obj)) throw new Error(`Expected key "${key}"`); },
    async writeArtifact(filename, content) {
      mkdirSync(flowDir, { recursive: true });
      const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      writeFileSync(join(flowDir, filename), data);
    },
    skip(reason) {
      console.log(`  ${skp} skipped — ${reason}`);
      steps.push({ name: '__skip__', status: 'skip', reason });
    },
    getSteps: () => steps,
  };
}

async function main() {
  console.log(`${c.bold}debugg-ai-mcp evals${c.reset}`);
  console.log(`Root: ${ROOT}`);

  if (!SKIP_BUILD) {
    hdr('Build');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    console.log(`  ${ok} Build succeeded`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(ARTIFACTS_ROOT, runId);
  mkdirSync(runDir, { recursive: true });

  hdr('Discover flows');
  const flowFiles = readdirSync(FLOWS_DIR).filter(f => f.endsWith('.mjs')).sort();
  const flows = [];
  for (const file of flowFiles) {
    const mod = await import(pathToFileURL(join(FLOWS_DIR, file)).href);
    if (!mod.flow) {
      console.log(`  ${c.yellow}WARN${c.reset}  ${file}: no "flow" export, skipping`);
      continue;
    }
    if (FLOW_FILTER && mod.flow.name !== FLOW_FILTER) continue;
    flows.push({ file, ...mod.flow });
  }
  if (flows.length === 0) {
    console.error(`\n${bad} No flows matched${FLOW_FILTER ? ` filter "${FLOW_FILTER}"` : ''}`);
    process.exit(1);
  }
  for (const f of flows) console.log(`  • ${f.name} ${c.dim}(${f.file})${c.reset}`);
  console.log(`  Artifacts: ${runDir}`);

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
  proc.on('error', e => { console.error(`  ${bad} Server error: ${e.message}`); process.exit(1); });
  await new Promise(r => setTimeout(r, 400));
  console.log(`  ${ok} Server started (pid ${proc.pid})`);

  const client = new MCPClient(proc);

  try {
    const r = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'eval-runner', version: '1.0.0' },
    });
    if (!r.serverInfo?.name) throw new Error('serverInfo.name missing');
    client.notify('notifications/initialized', {});
    console.log(`  ${ok} MCP initialize OK (${r.serverInfo.name})`);
  } catch (e) {
    console.error(`  ${bad} Initialize failed: ${e.message}`);
    client.close();
    process.exit(1);
  }

  const flowResults = [];
  for (const flow of flows) {
    hdr(`Flow: ${flow.name}`);
    if (flow.description) console.log(`  ${c.dim}${flow.description}${c.reset}`);
    const flowDir = join(runDir, flow.name);
    const ctx = makeFlowContext({ client, flowDir });
    const t0 = Date.now();
    let fatal = null;
    try {
      await flow.run(ctx);
    } catch (e) {
      fatal = e.message;
      console.log(`  ${bad} Fatal in flow: ${c.red}${e.message}${c.reset}`);
    }
    const steps = ctx.getSteps();
    let status;
    if (fatal) status = 'fail';
    else if (steps.length === 0) status = 'skip';
    else if (steps.every(s => s.status === 'skip')) status = 'skip';
    else if (steps.some(s => s.status === 'fail')) status = 'fail';
    else status = 'pass';
    const ms = Date.now() - t0;
    flowResults.push({ name: flow.name, status, ms, fatal, steps });
    await ctx.writeArtifact('result.json', { name: flow.name, status, ms, fatal, steps });
  }

  client.close();

  hdr('Summary');
  const passed  = flowResults.filter(f => f.status === 'pass').length;
  const failed  = flowResults.filter(f => f.status === 'fail').length;
  const skipped = flowResults.filter(f => f.status === 'skip').length;
  for (const f of flowResults) {
    const mark = f.status === 'pass' ? ok : f.status === 'fail' ? bad : skp;
    const suffix = f.fatal ? ` — ${c.red}${f.fatal}${c.reset}` : '';
    console.log(`  ${mark} ${f.name} ${c.dim}(${f.ms}ms)${c.reset}${suffix}`);
  }
  console.log(`\n  ${c.green}Passed:${c.reset}  ${passed}`);
  if (failed)  console.log(`  ${c.red}Failed:${c.reset}  ${failed}`);
  if (skipped) console.log(`  ${c.yellow}Skipped:${c.reset} ${skipped}`);

  writeFileSync(join(runDir, 'summary.json'),
    JSON.stringify({ passed, failed, skipped, flows: flowResults }, null, 2));
  console.log(`  Summary: ${join(runDir, 'summary.json')}`);

  if (failed > 0) {
    console.log(`\n${c.red}${c.bold}EVAL FAILED${c.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${c.green}${c.bold}EVAL PASSED${c.reset}\n`);
  }
}

main().catch(e => {
  console.error(`\n${c.red}Fatal:${c.reset} ${e.message}`);
  if (process.env.DEBUG_E2E) console.error(e.stack);
  process.exit(1);
});
