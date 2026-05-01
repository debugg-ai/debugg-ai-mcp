/**
 * Modal dialog interaction: agent clicks a trigger, recognizes the
 * resulting modal, clicks a button INSIDE the modal, and verifies the
 * follow-on state (toast).
 *
 * Layered UI is a classic tripping point for browser agents: after
 * clicking "Delete", the visible page hasn't navigated — the modal
 * overlays the original. The agent must:
 *   1. Recognize the modal's presence
 *   2. Target the button inside the modal, not the underlying page
 *   3. Wait for the modal to close + toast to appear
 *   4. Verify the toast text
 *
 * Uses a custom HTML modal rather than window.confirm() — confirm()
 * blocks the event loop and browser agents typically intercept or
 * auto-dismiss it differently; a custom modal tests the real interaction
 * pattern.
 *
 * ~45-90s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Item Manager</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
    button { padding: 10px 20px; font-size: 14px; cursor: pointer; border: 0; border-radius: 4px; }
    #delete { background: #dc2626; color: white; }
    #confirm { background: #dc2626; color: white; margin-right: 8px; }
    #cancel { background: #e5e7eb; color: #111827; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; }
    .overlay.hidden { display: none; }
    .modal { background: white; padding: 30px; border-radius: 8px; min-width: 320px; }
    .modal h2 { margin-top: 0; }
    #toast {
      position: fixed; bottom: 30px; right: 30px;
      padding: 14px 20px; background: #059669; color: white;
      border-radius: 6px; font-size: 14px;
      opacity: 0; transition: opacity 200ms;
    }
    #toast.visible { opacity: 1; }
  </style>
</head>
<body>
  <h1>Item Manager</h1>
  <p>Manage your items below.</p>
  <div class="item">
    <span>Widget #42</span>
    <button id="delete" type="button">Delete Item</button>
  </div>

  <div id="modal" class="overlay hidden" role="dialog" aria-modal="true">
    <div class="modal">
      <h2>Are you sure?</h2>
      <p>This action cannot be undone. The item will be permanently deleted.</p>
      <button id="confirm" type="button">Confirm</button>
      <button id="cancel" type="button">Cancel</button>
    </div>
  </div>

  <div id="toast">Item deleted successfully!</div>

  <script>
    var modal = document.getElementById('modal');
    var toast = document.getElementById('toast');
    document.getElementById('delete').addEventListener('click', function () {
      modal.classList.remove('hidden');
    });
    document.getElementById('cancel').addEventListener('click', function () {
      modal.classList.add('hidden');
    });
    document.getElementById('confirm').addEventListener('click', function () {
      modal.classList.add('hidden');
      toast.classList.add('visible');
      // Keep toast visible indefinitely so the agent can verify it
    });
  </script>
</body>
</html>`;

export const flow = {
  name: 'modal-dialog',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent clicks Delete → recognizes confirmation modal → clicks Confirm → verifies success toast',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: modal-delete page at ${url}\x1b[0m`);

    try {
      await step('agent clicks Delete, confirms modal, verifies success toast', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page has an Item Manager with a "Delete Item" button. ' +
              'Click the "Delete Item" button — a confirmation modal should appear with the heading "Are you sure?" and two buttons (Confirm and Cancel). ' +
              'Click the "Confirm" button inside the modal. ' +
              'After confirming, verify that a success toast appears containing the text "Item deleted successfully!".',
          },
        }, 420_000);

        await writeArtifact('modal-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('modal-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed modal interaction. outcome='${body.outcome}', success=${body.success}. ` +
          `final intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true,
          `Expected success=true; got ${body.success}`);

        // Agent must take at least 2 distinct actions for "click → confirm"
        assert(body.stepsTaken >= 2,
          `Expected stepsTaken >=2 for click-and-confirm; got ${body.stepsTaken}. ` +
          `Agent may have skipped the modal interaction entirely.`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
