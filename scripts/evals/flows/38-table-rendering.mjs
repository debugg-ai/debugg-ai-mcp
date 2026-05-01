/**
 * Structured-data fidelity: agent must read CONCRETE cell contents, not
 * just claim "a table is there".
 *
 * Flow 35 proves the agent differentiates truth vs. lie on generic page
 * structure. This flow narrows the screw by asking for row-level facts
 * that only a real read of the table could produce. We test both:
 *   (a) specific cell content — "row 3's Name is 'Carol Diaz' and Role is 'Viewer'"
 *   (b) specific count — "the table has exactly 5 data rows"
 *
 * Two steps:
 *   1. Accurate claim about the fixture → outcome='pass'
 *   2. Wrong claim about row 3's Role → outcome='fail'
 *
 * The negative step catches the failure mode where the agent reads
 * "there is a <table>" and stops — calling pass without actually
 * consuming row data. If that happens, the agent would pass BOTH
 * truthful and false row-specific descriptions.
 *
 * ~70s wall time (2 browser runs, tunnel reused).
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>User Directory</title>
  <style>
    body { font-family: sans-serif; padding: 40px; }
    table { border-collapse: collapse; width: 100%; max-width: 700px; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
    th { background: #f3f4f6; font-weight: 600; }
    tbody tr:hover { background: #fafafa; }
  </style>
</head>
<body>
  <h1>User Directory</h1>
  <p>All active team members.</p>
  <table id="users">
    <thead>
      <tr><th>Name</th><th>Email</th><th>Role</th></tr>
    </thead>
    <tbody>
      <tr><td>Alice Park</td><td>alice@example.com</td><td>Admin</td></tr>
      <tr><td>Bob Chen</td><td>bob@example.com</td><td>Editor</td></tr>
      <tr><td>Carol Diaz</td><td>carol@example.com</td><td>Viewer</td></tr>
      <tr><td>David Kim</td><td>david@example.com</td><td>Admin</td></tr>
      <tr><td>Eve Rossi</td><td>eve@example.com</td><td>Editor</td></tr>
    </tbody>
  </table>
</body>
</html>`;

export const flow = {
  name: 'table-rendering',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Agent reads specific cell contents from a 5-row user table, not just "a table exists"',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: user directory table at ${url}\x1b[0m`);

    let accurateBody;
    let wrongBody;

    try {
      await step('accurate description of row 3 (Carol Diaz / Viewer) + row count → outcome=pass', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page should display a user directory with a table of users. ' +
              'The table should have columns Name, Email, and Role, and exactly 5 data rows. ' +
              'The third data row should have Name "Carol Diaz", Email "carol@example.com", and Role "Viewer".',
          },
        }, 360_000);

        await writeArtifact('accurate-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        accurateBody = JSON.parse(r.content[0].text);
        await writeArtifact('accurate-body.json', accurateBody);

        assert(accurateBody.outcome === 'pass',
          `Expected outcome='pass' for accurate claims about row 3; got outcome='${accurateBody.outcome}'. ` +
          `intent: ${accurateBody.actionTrace?.[accurateBody.actionTrace.length - 1]?.intent?.slice(0, 300) ?? '(none)'}`);
        assert(accurateBody.success === true,
          `Expected success=true; got ${accurateBody.success}`);
      });

      await step('WRONG claim about row 3 Role ("Admin" instead of "Viewer") → outcome=fail', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page should display a user directory table. ' +
              'The third data row should have Name "Carol Diaz", Email "carol@example.com", and Role "Admin".',
          },
        }, 360_000);

        await writeArtifact('wrong-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        wrongBody = JSON.parse(r.content[0].text);
        await writeArtifact('wrong-body.json', wrongBody);

        // If the agent only scans "is there a table?" and rubber-stamps,
        // this will pass — catching exactly the bug we care about.
        assert(wrongBody.outcome !== 'pass',
          `AGENT DID NOT READ THE ROLE CELL. ` +
          `Description claimed row 3 Role='Admin'; actual fixture has Role='Viewer'. ` +
          `Agent returned outcome='${wrongBody.outcome}', success=${wrongBody.success}. ` +
          `This indicates the agent saw "a table" and rubber-stamped without reading the cell values. ` +
          `intent: ${wrongBody.actionTrace?.[wrongBody.actionTrace.length - 1]?.intent?.slice(0, 300) ?? '(none)'}`);
        assert(wrongBody.success === false,
          `Expected success=false for a false cell claim; got ${wrongBody.success}`);
      });

      await step('the two runs are distinct evaluations (different executionIds)', async () => {
        assert(accurateBody.executionId !== wrongBody.executionId,
          `Both calls returned the same executionId — looks cached`);
        await writeArtifact('comparison.json', {
          accurate: {
            outcome: accurateBody.outcome,
            success: accurateBody.success,
            executionId: accurateBody.executionId,
            finalIntent: accurateBody.actionTrace?.[accurateBody.actionTrace.length - 1]?.intent,
          },
          wrong: {
            outcome: wrongBody.outcome,
            success: wrongBody.success,
            executionId: wrongBody.executionId,
            finalIntent: wrongBody.actionTrace?.[wrongBody.actionTrace.length - 1]?.intent,
          },
        });
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
