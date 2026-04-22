/**
 * MCP protocol handshake + tool discovery.
 *
 * Asserts both the shape of every tool (2025-11-25 required fields) and the
 * expected roster — so silently-dropped tools or stale wiring fail here.
 * Update EXPECTED_TOOLS when a new tool lands.
 */

const EXPECTED_TOOLS = [
  'check_app_in_browser',
  'trigger_crawl',
  'list_projects',
  'list_environments',
  'list_credentials',
  'create_environment',
  'create_credential',
  'get_environment',
  'update_environment',
  'delete_environment',
  'get_credential',
  'update_credential',
  'delete_credential',
  'get_project',
  'update_project',
  'delete_project',
  'list_executions',
  'get_execution',
  'cancel_execution',
  'list_teams',
  'list_repos',
  'create_project',
];

export const flow = {
  name: 'protocol',
  tags: ['fast', 'protocol'],
  description: 'MCP handshake + tools/list schema + roster lock',
  async run({ client, step, assert, writeArtifact }) {
    let toolList;
    await step('tools/list returns at least one tool', async () => {
      toolList = await client.request('tools/list', {});
      await writeArtifact('tools-list.json', toolList);
      assert(Array.isArray(toolList.tools), 'tools is not an array');
      assert(toolList.tools.length > 0, 'tools/list returned empty array');
    });

    await step('every tool has name, title, description, inputSchema', async () => {
      for (const t of toolList.tools) {
        assert(t.name,        'Tool missing name');
        assert(t.title,       `Tool ${t.name} missing title`);
        assert(t.description, `Tool ${t.name} missing description`);
        assert(t.inputSchema, `Tool ${t.name} missing inputSchema`);
      }
    });

    await step(`roster lock: exactly ${EXPECTED_TOOLS.length} tools, names match expected set`, async () => {
      const actual = toolList.tools.map(t => t.name).sort();
      const expected = [...EXPECTED_TOOLS].sort();
      assert(
        actual.length === expected.length,
        `Tool count mismatch: expected ${expected.length}, got ${actual.length}. Actual: [${actual.join(', ')}]`,
      );
      const missing = expected.filter(name => !actual.includes(name));
      const unexpected = actual.filter(name => !expected.includes(name));
      assert(
        missing.length === 0,
        `Missing tools: [${missing.join(', ')}]`,
      );
      assert(
        unexpected.length === 0,
        `Unexpected tools: [${unexpected.join(', ')}]. Update EXPECTED_TOOLS in 01-protocol.mjs if intentional.`,
      );
    });
  },
};
