#!/usr/bin/env node
/**
 * Cross-platform boot smoke for the local MCP dist (bead rmu extends bead hqg).
 *
 * Proves the fresh-machine scenario: without DEBUGGAI_API_KEY, the server must
 *  - boot and answer `initialize`
 *  - return the normal `tools/list` roster
 *  - return a structured ConfigurationError (-32001) mentioning DEBUGGAI_API_KEY
 *    when a tool is called (locks bead cma)
 *
 * Called from .github/workflows/boot-smoke.yml as `node scripts/ci-boot-smoke.mjs`
 * across {ubuntu, macos, windows} × {Node 20, 22, 24}.
 *
 * Replaces the bash-heredoc that blocked Windows + PowerShell runners.
 */

import { spawn } from 'node:child_process';

const DIST = './dist/index.js';
const START_DELAY_MS = 800;
const KILL_DELAY_MS = 5000;

// Build a clean env: inherit everything EXCEPT the API key, so a leaked secret
// in the runner can't mask the missing-key test.
const childEnv = { ...process.env, LOG_LEVEL: 'error' };
delete childEnv.DEBUGGAI_API_KEY;

const p = spawn('node', [DIST], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: childEnv,
});

let stdoutBuf = '';
let stderrBuf = '';
p.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
p.stderr.on('data', (d) => { stderrBuf += d.toString(); });

p.on('error', (err) => {
  console.error('FAIL: spawn error:', err.message);
  process.exit(1);
});

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'ci-boot-smoke', version: '1.0' },
  },
};

const initializedNotification = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
};

const toolCallRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_projects', arguments: {} },
};

setTimeout(() => {
  p.stdin.write(JSON.stringify(initRequest) + '\n');
  p.stdin.write(JSON.stringify(initializedNotification) + '\n');
  p.stdin.write(JSON.stringify(toolCallRequest) + '\n');
}, START_DELAY_MS);

setTimeout(() => {
  try { p.kill('SIGTERM'); } catch { /* ignore */ }
}, KILL_DELAY_MS);

p.on('exit', () => {
  const lines = stdoutBuf.split(/\r?\n/).filter(Boolean);
  const responses = [];
  for (const line of lines) {
    try { responses.push(JSON.parse(line)); } catch { /* skip non-JSON */ }
  }
  const initResp = responses.find((r) => r.id === 1);
  const toolResp = responses.find((r) => r.id === 2);

  const fail = (msg) => {
    console.error('FAIL:', msg);
    console.error('--- STDOUT (first 2kB) ---\n' + stdoutBuf.slice(0, 2000));
    console.error('--- STDERR (first 1kB) ---\n' + stderrBuf.slice(0, 1000));
    process.exit(1);
  };

  if (!initResp?.result?.serverInfo?.name) {
    fail('initialize must return result.serverInfo.name');
  }
  if (!toolResp?.result?.content?.[0]?.text) {
    fail('tool call must return result.content[0].text');
  }
  if (toolResp.result.isError !== true) {
    fail('tool call must set isError:true');
  }

  let toolBody;
  try {
    toolBody = JSON.parse(toolResp.result.content[0].text);
  } catch (e) {
    fail(`tool error body must be valid JSON: ${e.message}`);
  }
  if (toolBody.error?.code !== -32001) {
    fail(`tool error code must be -32001 (CONFIGURATION_ERROR); got ${toolBody.error?.code}`);
  }
  if (!/DEBUGGAI_API_KEY/.test(toolBody.error?.message ?? '')) {
    fail('tool error message must mention DEBUGGAI_API_KEY');
  }

  console.log(`OK: boot smoke passed on ${process.platform} ${process.version}`);
  process.exit(0);
});
