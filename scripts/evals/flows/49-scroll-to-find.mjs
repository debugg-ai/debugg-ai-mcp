/**
 * Scroll-to-find: target content lives far below the initial viewport.
 * Agent must scroll to locate it, not pass based on "I see the title
 * at the top of the page".
 *
 * Fixture: 10-section long-form article (~4000px tall). Each section
 * has a distinct heading and paragraph. The target phrase ("quantum
 * flux regulator to 42 MHz") lives in Section 7, far below the fold.
 *
 * Each section is padded with enough filler to push Section 7 well off
 * the initial viewport on any realistic browser size. If the agent
 * doesn't scroll, it can't have seen the target text, and a strict
 * read-based assertion will catch that — either via outcome=fail or
 * by the agent hallucinating (which would be a much worse bug).
 *
 * ~60-120s wall time.
 */

import { createServer } from 'node:http';

function section(n, heading, body) {
  return `<section style="min-height:420px;padding:30px 0;border-bottom:1px solid #e5e7eb;">
    <h2>Section ${n}: ${heading}</h2>
    <p>${body}</p>
  </section>`;
}

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Technical Manual</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 720px; line-height: 1.6; color: #111827; }
    h1 { margin-bottom: 10px; }
    h2 { color: #1f2937; }
    p { color: #374151; }
  </style>
</head>
<body>
  <h1>Flux Capacitor Technical Manual</h1>
  <p>Complete operating manual for the Series-9 flux capacitor unit.</p>

  ${section(1, 'Introduction', 'This manual covers safe operation of the Series-9 flux capacitor. Read thoroughly before powering on.')}
  ${section(2, 'Safety First', 'Always wear protective equipment. Ensure the unit is properly grounded before operation.')}
  ${section(3, 'Installation', 'Mount the capacitor to a rigid frame using the four M8 bolts provided. Torque to 25 N·m.')}
  ${section(4, 'Initial Calibration', 'Run the self-calibration routine by pressing CAL + HOLD for 5 seconds on first boot.')}
  ${section(5, 'Connecting Peripherals', 'The Series-9 supports up to eight I/O modules. Insert modules into slots 1-8.')}
  ${section(6, 'Baseline Configuration', 'The factory defaults work for most applications. Advanced users may adjust as needed.')}
  ${section(7, 'Advanced Tuning', 'To achieve optimal performance, configure the quantum flux regulator to 42 MHz. Deviation beyond ±2 MHz will cause instability.')}
  ${section(8, 'Troubleshooting', 'If the unit shows red LED, cycle power and re-run calibration. Persistent errors require RMA.')}
  ${section(9, 'Maintenance Schedule', 'Inspect seals every 90 days. Replace filter cartridge annually.')}
  ${section(10, 'Legal Notice', 'This product is warranted against manufacturing defects for 12 months from date of purchase.')}
</body>
</html>`;

export const flow = {
  name: 'scroll-to-find',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Target content in Section 7 is far below fold; agent must scroll to find "quantum flux regulator to 42 MHz"',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: long-form manual at ${url} (Section 7 is ~2500px down)\x1b[0m`);

    try {
      await step('find Section 7 "Advanced Tuning" containing "quantum flux regulator to 42 MHz" (below fold)', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a long technical manual with 10 numbered sections. ' +
              'Scroll down to locate "Section 7: Advanced Tuning". ' +
              'Verify that Section 7 contains the specific instruction ' +
              '"configure the quantum flux regulator to 42 MHz".',
          },
        }, 420_000);

        await writeArtifact('scroll-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('scroll-body.json', body);

        assert(body.outcome === 'pass',
          `Agent failed to find content below fold. outcome='${body.outcome}'. ` +
          `If this fails consistently, the agent may not be scrolling. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 400) ?? '(none)'}`);
        assert(body.success === true, `Expected success=true; got ${body.success}`);

        await writeArtifact('action-trace.json', body.actionTrace ?? []);
        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));

        // Log stepsTaken as diagnostic — helps future sessions understand
        // agent's scroll-and-search behavior cost.
        console.log(`  \x1b[2magent stepsTaken=${body.stepsTaken}, durationMs=${body.durationMs}\x1b[0m`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
