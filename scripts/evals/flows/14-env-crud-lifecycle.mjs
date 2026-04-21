/**
 * TDD red: this flow MUST FAIL until get_environment, update_environment,
 * and delete_environment are implemented. Every new-tool call will return a
 * JSON-RPC "Unknown tool" error in the red state.
 *
 * Green definition (full env CRUD lifecycle):
 *   1. create_environment → capture uuid
 *   2. get_environment({uuid}) → returns {environment: {uuid,name,url,isActive,description,...}}
 *   3. update_environment({uuid, description}) → returns {updated:true, environment:{...patched}}
 *   4. get_environment({uuid}) → description now reflects the patch
 *   5. delete_environment({uuid}) → returns {deleted:true, uuid}
 *   6. get_environment({uuid}) → isError:true, error NotFound
 *
 * Cleanup uses direct backend DELETE as a fallback so a failed run (common
 * during red→green transitions) doesn't leak envs into the account.
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
  const r = await fetch(
    `${API_BASE}/api/v1/projects/${projectUuid}/environments/${envUuid}/`,
    { method: 'DELETE', headers: { Authorization: `Token ${API_KEY}` } },
  );
  if (!r.ok && r.status !== 404) {
    console.log(`  \x1b[33mWARN\x1b[0m cleanup DELETE failed: ${r.status}`);
  }
}

async function getEnvDirect(projectUuid, envUuid) {
  const r = await fetch(
    `${API_BASE}/api/v1/projects/${projectUuid}/environments/${envUuid}/`,
    { headers: { Authorization: `Token ${API_KEY}` } },
  );
  return { status: r.status, body: await r.json().catch(() => null) };
}

export const flow = {
  name: 'env-crud-lifecycle',
  description: 'TDD: create → get → update → re-get → delete → get-returns-NotFound',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const initialName = `mcp-eval-env-crud-${ts}`;
    const updatedDescription = `updated-desc-${ts}`;
    let projectUuid = null;
    let envUuid = null;

    try {
      await step('setup: create env via existing create_environment tool', async () => {
        const r = await client.request('tools/call', {
          name: 'create_environment',
          arguments: {
            name: initialName,
            url: 'https://example.invalid/env-crud',
            description: 'original-desc',
          },
        }, 30_000);
        assert(!r.isError, `create failed: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        projectUuid = body.projectUuid;
        envUuid = body.environment.uuid;
        await writeArtifact('setup.json', body);
      });

      await step('get_environment returns full env by uuid', async () => {
        const r = await client.request('tools/call', {
          name: 'get_environment',
          arguments: { uuid: envUuid },
        }, 30_000);
        await writeArtifact('get.json', r);
        assert(!r.isError, `get_environment error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.environment, 'response missing .environment');
        assert(body.environment.uuid === envUuid, `uuid mismatch: ${body.environment.uuid}`);
        assert(body.environment.name === initialName, `name mismatch: ${body.environment.name}`);
        assert(body.environment.url === 'https://example.invalid/env-crud', 'url mismatch');
        assert(typeof body.environment.isActive === 'boolean', 'isActive missing');
      });

      await step('update_environment patches description and echoes updated resource', async () => {
        const r = await client.request('tools/call', {
          name: 'update_environment',
          arguments: { uuid: envUuid, description: updatedDescription },
        }, 30_000);
        await writeArtifact('update.json', r);
        assert(!r.isError, `update_environment error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.updated === true, 'response missing updated:true');
        assert(body.environment, 'response missing .environment');
        assert(body.environment.uuid === envUuid, `uuid not echoed: ${body.environment.uuid}`);
        assert(body.environment.description === updatedDescription,
          `description not updated: ${body.environment.description}`);
        assert(body.environment.name === initialName, `name unexpectedly changed: ${body.environment.name}`);
      });

      await step('get_environment reflects the patched description', async () => {
        const r = await client.request('tools/call', {
          name: 'get_environment',
          arguments: { uuid: envUuid },
        }, 30_000);
        assert(!r.isError, `second get error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.environment.description === updatedDescription,
          `patch not persisted: ${body.environment.description}`);
      });

      await step('delete_environment removes the env and returns {deleted:true, uuid}', async () => {
        const r = await client.request('tools/call', {
          name: 'delete_environment',
          arguments: { uuid: envUuid },
        }, 30_000);
        await writeArtifact('delete.json', r);
        assert(!r.isError, `delete_environment error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.deleted === true, 'response missing deleted:true');
        assert(body.uuid === envUuid, `uuid mismatch: ${body.uuid}`);

        // Belt-and-suspenders: verify via backend direct GET that the env is actually gone
        const verify = await getEnvDirect(projectUuid, envUuid);
        assert(verify.status === 404, `backend still has env after MCP delete: status=${verify.status}`);
        envUuid = null; // signal cleanup is not needed
      });

      await step('get_environment on deleted uuid returns NotFound (isError:true)', async () => {
        const r = await client.request('tools/call', {
          name: 'get_environment',
          arguments: { uuid: envUuid ?? '00000000-0000-0000-0000-000000000000' },
        }, 30_000);
        await writeArtifact('get-after-delete.json', r);
        // For a deleted env (or any nonexistent uuid), MCP should return a
        // structured error response, not a 200 with arbitrary data.
        assert(r.isError === true, 'expected isError:true on deleted/missing uuid');
        const body = JSON.parse(r.content[0].text);
        assert(
          (body.error && /not.?found/i.test(body.error + (body.message ?? ''))) ||
          /not.?found/i.test(body.message ?? ''),
          `expected NotFound error, got: ${JSON.stringify(body).slice(0, 200)}`
        );
      });
    } finally {
      if (envUuid && projectUuid) {
        await deleteEnvDirect(projectUuid, envUuid);
        console.log(`  \x1b[2mcleanup: deleted env ${envUuid} via direct API\x1b[0m`);
      }
    }
  },
};
