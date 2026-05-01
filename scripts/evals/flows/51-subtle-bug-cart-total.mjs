/**
 * The "subtle bug" test: fixture LOOKS like a working cart but has a
 * deceptive bug — the total is always displayed as $0.00 regardless of
 * what's in the cart. The page renders cleanly, no error message, no
 * console errors, items list correctly with their prices. Only the
 * Total line is wrong.
 *
 * This is the failure mode where:
 *   - HTTP returns 200 ✓
 *   - Page renders without errors ✓
 *   - Most content matches description ✓
 *   - Layout looks normal ✓
 *   - One specific value is wrong ✗
 *
 * A rubber-stamping agent that does "shape verification" (see a list, see
 * a total line, call it pass) would miss this. A rigorous agent that
 * computes the expected total from listed prices and compares against
 * the displayed total would catch it.
 *
 * Companion to flow 37 (broken-js-skeleton — content missing) and flow
 * 38 (table-rendering — wrong cell value). This is the most subtle of
 * the three because the wrong value is mathematically derivable from
 * other values on the same page.
 *
 * Description: "cart shows 3 items totaling $67.97"
 * Reality: 3 items list with correct individual prices, but Total = $0.00
 *
 * Expected: outcome=fail.
 *
 * ~30-60s wall time.
 */

import { createServer } from 'node:http';

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Cart</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; }
    .item { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #e5e7eb; font-size: 16px; }
    .price { font-weight: 600; color: #111827; }
    .total { display: flex; justify-content: space-between; padding: 20px 0; font-size: 22px; font-weight: 700; }
    .total .price { color: #2563eb; }
    button { margin-top: 20px; padding: 12px 24px; background: #059669; color: white; border: 0; cursor: pointer; border-radius: 4px; font-size: 15px; }
  </style>
</head>
<body>
  <h1>Your Cart</h1>
  <p>Review your items before checkout.</p>

  <div class="item"><span>Cotton T-Shirt</span><span class="price">$19.99</span></div>
  <div class="item"><span>Canvas Tote Bag</span><span class="price">$24.99</span></div>
  <div class="item"><span>Stainless Mug</span><span class="price">$22.99</span></div>

  <div class="total">
    <span>Total</span>
    <span class="price" id="total">$0.00</span>
  </div>

  <button type="button">Proceed to Checkout</button>

  <script>
    // INTENTIONAL BUG for this test fixture: the total is supposed to be
    // computed from the line items but is hardcoded to $0.00. A real
    // user clicking Proceed to Checkout would be very confused. A rigorous
    // browser agent should notice that 19.99 + 24.99 + 22.99 = 67.97
    // does NOT equal the displayed total of 0.00.
    //
    // Real-world analog: a payment-display bug where the API returns
    // null/0 for total but the cart-items list is correct — silently
    // breaks revenue.
    document.getElementById('total').textContent = '$0.00';
  </script>
</body>
</html>`;

export const flow = {
  name: 'subtle-bug-cart-total',
  tags: ['browser', 'browser-local', 'tunnel'],
  description: 'Cart fixture has a deceptive bug: total shows $0.00 instead of actual sum. Agent must catch the math discrepancy.',
  async run({ client, step, assert, writeArtifact }) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`  \x1b[2mfixture: cart with broken total at ${url}\x1b[0m`);

    try {
      await step('description claims total=$67.97; fixture shows $0.00; agent must catch the discrepancy', async () => {
        const r = await client.request('tools/call', {
          name: 'check_app_in_browser',
          arguments: {
            url,
            description:
              'The page is a shopping cart. Verify all of the following:\n' +
              '1. The cart contains exactly 3 items: Cotton T-Shirt ($19.99), Canvas Tote Bag ($24.99), Stainless Mug ($22.99).\n' +
              '2. The Total line displays the correct sum: $67.97.\n' +
              '3. A "Proceed to Checkout" button is visible.\n' +
              'The test passes only if ALL three claims are correct.',
          },
        }, 360_000);

        await writeArtifact('subtle-bug-response.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);

        const body = JSON.parse(r.content[0].text);
        await writeArtifact('subtle-bug-body.json', body);

        // The killer assertion: agent must catch a numeric discrepancy
        // that's hidden in plain sight. If it rubber-stamps based on
        // "the page has a Total line, items match", this fails.
        assert(body.outcome !== 'pass',
          `AGENT MISSED A SUBTLE BUG. ` +
          `Cart shows items totaling $67.97 but the Total line displays $0.00. ` +
          `Agent did not catch this discrepancy. Got outcome='${body.outcome}'. ` +
          `This is exactly the class of bug that loses real revenue silently. ` +
          `intent: ${body.actionTrace?.[body.actionTrace.length - 1]?.intent?.slice(0, 500) ?? '(none)'}`);
        assert(body.success === false,
          `Expected success=false; got ${body.success}`);

        const finalIntent = body.actionTrace?.[body.actionTrace.length - 1]?.intent ?? '';
        await writeArtifact('agent-final-intent.txt', String(finalIntent));

        // Soft signal: the agent's diagnostic text should mention the
        // total OR mention $0 — proving it actually noticed the wrong
        // value, not just hallucinated a generic failure. Don't be too
        // strict; agents phrase things differently.
        const intentLower = finalIntent.toLowerCase();
        const noticedTotal =
          intentLower.includes('total') ||
          intentLower.includes('$0') ||
          intentLower.includes('0.00') ||
          intentLower.includes('zero') ||
          intentLower.includes('67.97');
        assert(noticedTotal,
          `Agent reported fail but didn't reference the bug it caught. ` +
          `Final intent: "${finalIntent}". ` +
          `Expected mention of: total / $0 / 0.00 / zero / 67.97. ` +
          `If agent fails generically without identifying WHAT it caught, future regressions may slip through.`);
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
