/**
 * MCP protocol handshake + tool discovery.
 *
 * Asserts on the shape of tools/list (non-empty; every tool has the 2025-11-25
 * required fields) rather than a hardcoded tool roster. The actual tool roster
 * is captured in the artifact for diffing over time.
 *
 * See bead debugg-ai-mcp-xkw for docs↔code divergence (docs claim 13 tools,
 * server currently registers 1). When that is resolved, add a roster-lock
 * step here to prevent silent regressions.
 */

export const flow = {
  name: 'protocol',
  description: 'MCP handshake + tools/list schema (shape-only)',
  async run({ client, step, assert, writeArtifact }) {
    await step('tools/list returns at least one tool', async () => {
      const r = await client.request('tools/list', {});
      await writeArtifact('tools-list.json', r);
      assert(Array.isArray(r.tools), 'tools is not an array');
      assert(r.tools.length > 0, 'tools/list returned empty array');
    });

    await step('every tool has name, title, description, inputSchema', async () => {
      const r = await client.request('tools/list', {});
      for (const t of r.tools) {
        assert(t.name,        'Tool missing name');
        assert(t.title,       `Tool ${t.name} missing title`);
        assert(t.description, `Tool ${t.name} missing description`);
        assert(t.inputSchema, `Tool ${t.name} missing inputSchema`);
      }
    });
  },
};
