/**
 * check_app_in_browser against example.com — full browser-agent smoke test.
 * Validates structured response shape and that the internal tunnel URL isn't leaked.
 */

export const flow = {
  name: 'check-public-url',
  description: 'check_app_in_browser against example.com (real browser agent)',
  async run({ client, step, assert, assertHas, writeArtifact }) {
    await step('check_app_in_browser — example.com, structured result, no tunnel leak', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: {
          url: 'https://example.com',
          description: 'Check that the page loads and displays a heading',
        },
      }, 360_000);
      await writeArtifact('check-app.json', r);

      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
      const text = r.content[0].text;
      const body = JSON.parse(text);

      assertHas(body, 'outcome');
      assertHas(body, 'success');
      assertHas(body, 'targetUrl');
      assert(body.targetUrl === 'https://example.com', `targetUrl wrong: ${body.targetUrl}`);
      assert(!text.includes('ngrok.debugg.ai'), 'Response leaks internal tunnel URL');
    });
  },
};
