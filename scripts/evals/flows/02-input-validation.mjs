/**
 * Tool-call input validation for tools that actually exist.
 *
 * Scoped to check_app_in_browser since that is the only registered tool today
 * (see bead debugg-ai-mcp-xkw). When more tools are registered, add their
 * validation checks here.
 */

export const flow = {
  name: 'input-validation',
  description: 'Tool-call input validation errors for check_app_in_browser',
  async run({ client, step, assert, writeArtifact }) {
    await step('check_app_in_browser — missing description → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: { url: 'https://example.com' },
      });
      await writeArtifact('missing-description.json', r);
      assert(r.isError === true, 'Expected isError: true');
      const text = r.content[0].text;
      assert(
        text.toLowerCase().includes('description') || text.toLowerCase().includes('valid'),
        `Expected validation message, got: ${text.slice(0, 200)}`
      );
    });

    await step('check_app_in_browser — missing url → validation error', async () => {
      const r = await client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: { description: 'test' },
      });
      assert(r.isError === true, 'Expected isError: true');
    });

    await step('unknown tool → JSON-RPC error (not tool isError)', async () => {
      try {
        await client.request('tools/call', { name: 'nonexistent_tool', arguments: {} });
        throw new Error('Expected RPC error but got success');
      } catch (e) {
        assert(
          e.message.includes('RPC error') || e.message.includes('Unknown'),
          `Unexpected error: ${e.message}`
        );
      }
    });
  },
};
