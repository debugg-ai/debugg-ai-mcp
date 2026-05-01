/**
 * MCP clean-shutdown contract.
 *
 * When Claude Code (the MCP client) disconnects from a Debugg AI MCP server,
 * the server MUST exit within a reasonable window. If it hangs, every
 * editor/agent shutdown leaks a zombie process — and because we also hold
 * ngrok agent refs, that leaks tunnel state into the user's dev machine.
 *
 * Two disconnect modes in production:
 *   (a) stdin EOF — the normal case when the parent closes the pipe
 *   (b) SIGTERM — explicit kill (e.g. editor restart)
 *
 * Both should:
 *   - Exit within a tight window (we pick 10s for stdin, 5s for SIGTERM)
 *   - Not wedge behind tunnelManager.stopAllTunnels (the graceful-shutdown
 *     path does this on signals; a buggy stopAllTunnels would hang here)
 *
 * We don't start any tool calls — just boot, initialize, then disconnect.
 * That's sufficient to lock the core contract and is fast (~1-2s per case).
 *
 * Tagged 'fast', 'multi-process' (spawns its own aux MCP subprocesses).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));
const DIST = join(ROOT, 'dist', 'index.js');
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;

function spawnMcp() {
  const proc = spawn('node', [DIST], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEBUGGAI_API_KEY: API_KEY },
  });
  // Drain stderr and capture so we can include it in error messages if
  // initialize fails to land.
  proc.stderrBuf = '';
  proc.stderr.on('data', (c) => { proc.stderrBuf += c.toString(); });
  return proc;
}

async function waitForInitializeResponse(proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && (msg.result || msg.error)) {
            proc.stdout.off('data', onData);
            clearTimeout(timer);
            if (msg.error) return reject(new Error(`initialize returned error: ${JSON.stringify(msg.error)}`));
            return resolve(msg);
          }
        } catch { /* not JSON — probably log noise, ignore */ }
      }
    };
    const timer = setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(
        `initialize response not seen within ${timeoutMs}ms. ` +
        `stderr: ${(proc.stderrBuf ?? '').slice(0, 500)}`,
      ));
    }, timeoutMs);
    proc.stdout.on('data', onData);
  });
}

async function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal, elapsedMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.off('exit', onExit);
      // Force-kill so we don't leave zombies if the test is re-run
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      resolve({ timedOut: true, code: null, signal: null, elapsedMs: timeoutMs });
    }, timeoutMs);
    const started = Date.now();
    proc.on('exit', onExit);
  });
}

function sendInitialize(proc) {
  const req = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'shutdown-flow', version: '0.0.1' },
    },
  };
  proc.stdin.write(JSON.stringify(req) + '\n');
}

export const flow = {
  name: 'clean-shutdown',
  tags: ['fast', 'multi-process', 'protocol'],
  description: 'MCP exits cleanly on stdin-close and SIGTERM within tight windows (no hang, tunnelManager.stopAllTunnels path works)',
  async run({ step, assert, writeArtifact }) {
    const STDIN_BUDGET_MS = 10_000;
    const SIGTERM_BUDGET_MS = 5_000;

    // ── stdin-close case ─────────────────────────────────────────────────
    await step(`MCP exits within ${STDIN_BUDGET_MS}ms of stdin close (normal Claude Code disconnect path)`, async () => {
      const proc = spawnMcp();
      try {
        sendInitialize(proc);
        await waitForInitializeResponse(proc);
        // Close stdin — simulate MCP client disconnecting its pipe.
        proc.stdin.end();
        const exit = await waitForExit(proc, STDIN_BUDGET_MS);
        await writeArtifact('stdin-close.json', { budgetMs: STDIN_BUDGET_MS, ...exit });

        assert(!exit.timedOut,
          `HANG: MCP did not exit within ${STDIN_BUDGET_MS}ms of stdin close — editor/agent disconnect would leak a zombie`);
        // SDK behavior: on stdin EOF the transport closes → server unrefs →
        // event loop exits with code 0 (usually). We lock "not timed out",
        // not a specific code, because SDK internals can change.
      } finally {
        if (proc.exitCode == null && proc.signalCode == null) {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }
    });

    // ── SIGTERM case — exercises gracefulShutdown + stopAllTunnels ───────
    await step(`MCP exits within ${SIGTERM_BUDGET_MS}ms of SIGTERM (graceful shutdown path)`, async () => {
      const proc = spawnMcp();
      try {
        sendInitialize(proc);
        await waitForInitializeResponse(proc);
        proc.kill('SIGTERM');
        const exit = await waitForExit(proc, SIGTERM_BUDGET_MS);
        await writeArtifact('sigterm.json', { budgetMs: SIGTERM_BUDGET_MS, ...exit });

        assert(!exit.timedOut,
          `HANG: MCP did not exit within ${SIGTERM_BUDGET_MS}ms of SIGTERM. Most likely cause: tunnelManager.stopAllTunnels is awaiting something that never settles.`);
        // Graceful-shutdown explicitly does process.exit(0), so lock that.
        assert(exit.code === 0,
          `Expected clean exit code 0 after SIGTERM; got code=${exit.code} signal=${exit.signal}. ` +
          `Non-zero after SIGTERM implies an error in the shutdown path (e.g. stopAllTunnels throwing).`);
      } finally {
        if (proc.exitCode == null && proc.signalCode == null) {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }
    });

    // ── Double-disconnect robustness — stdin close THEN SIGTERM ──────────
    // Covers a subtle pattern: some editors close stdin AND then send
    // SIGTERM after a short window. If stdin close already initiated
    // shutdown, a following SIGTERM hitting a nearly-dead process should
    // not explode (EPIPE, double-process.exit, etc.).
    await step('stdin close followed by SIGTERM is harmless (no crash, no delay)', async () => {
      const proc = spawnMcp();
      try {
        sendInitialize(proc);
        await waitForInitializeResponse(proc);
        proc.stdin.end();
        // Race: some chance the process has already exited before we send
        // SIGTERM. Either outcome is fine — we just don't want an error.
        setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch { /* process already reaped */ }
        }, 50);
        const exit = await waitForExit(proc, STDIN_BUDGET_MS);
        await writeArtifact('stdin-then-sigterm.json', { budgetMs: STDIN_BUDGET_MS, ...exit });
        assert(!exit.timedOut, `double-disconnect hung: ${JSON.stringify(exit)}`);
      } finally {
        if (proc.exitCode == null && proc.signalCode == null) {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }
    });
  },
};
