/**
 * create_environment: creates a throwaway env, asserts it appears in
 * list_environments, then cleans up by deleting it directly via the API.
 *
 * Uses a "mcp-eval-<timestamp>" name prefix so operators can spot stragglers
 * if a run is killed mid-flow and cleanup doesn't fire.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
const API_BASE = 'https://api.debugg.ai';

async function deleteEnvDirect(projectUuid, envUuid) {
  const url = `${API_BASE}/api/v1/projects/${projectUuid}/environments/${envUuid}/`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Token ${API_KEY}` },
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`Cleanup delete failed: ${r.status} ${await r.text()}`);
  }
}

export const flow = {
  name: 'create-environment',
  description: 'create_environment → list → delete lifecycle',
  async run({ client, step, assert, writeArtifact }) {
    const name = `mcp-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let createdUuid = null;
    let projectUuid = null;

    try {
      await step(`create env "${name}"`, async () => {
        const r = await client.request('tools/call', {
          name: 'create_environment',
          arguments: {
            name,
            url: 'https://example.invalid/mcp-eval',
            description: 'Throwaway env from MCP eval suite',
          },
        }, 30_000);
        await writeArtifact('create.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 400)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.created === true, 'Expected created: true');
        assert(typeof body.environment.uuid === 'string', 'environment.uuid missing');
        assert(body.environment.name === name, `name mismatch: ${body.environment.name} vs ${name}`);
        createdUuid = body.environment.uuid;
        projectUuid = body.projectUuid;
      });

      await step('new env appears in list_environments (filtered by q)', async () => {
        const r = await client.request('tools/call', {
          name: 'list_environments',
          arguments: { q: name },
        }, 30_000);
        await writeArtifact('list-after-create.json', r);
        const body = JSON.parse(r.content[0].text);
        assert(body.pageInfo.totalCount >= 1, `Expected >=1 match for q="${name}", got ${body.pageInfo.totalCount}`);
        const found = body.environments.find(e => e.uuid === createdUuid);
        assert(!!found, 'Newly-created env not found in filtered list');
      });

      await step('create_environment — projectUuid override creates on target project', async () => {
        // projectUuid above was auto-resolved; pass it explicitly this time
        const name2 = `mcp-eval-explicit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const r = await client.request('tools/call', {
          name: 'create_environment',
          arguments: { name: name2, url: 'https://example.invalid/explicit', projectUuid },
        }, 30_000);
        await writeArtifact('explicit-project.json', r);
        assert(!r.isError, `explicit projectUuid create failed: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.projectUuid === projectUuid, 'projectUuid echo mismatch');

        // Clean up this extra env immediately
        await deleteEnvDirect(projectUuid, body.environment.uuid);
      });
    } finally {
      if (createdUuid && projectUuid) {
        try {
          await deleteEnvDirect(projectUuid, createdUuid);
          console.log(`  \x1b[2mcleanup: deleted env ${createdUuid}\x1b[0m`);
        } catch (e) {
          console.log(`  \x1b[33mWARN\x1b[0m cleanup failed: ${e.message}`);
        }
      }
    }
  },
};
