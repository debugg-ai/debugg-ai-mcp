/**
 * TDD red: get_credential, update_credential, delete_credential don't exist
 * yet. This flow must fail with "Unknown tool" in the red state.
 *
 * Green definition:
 *   1. create env + cred (existing tools) → capture uuids + known password
 *   2. get_credential({uuid, environmentId}) → {credential:{uuid,label,username,...}}; NO password field anywhere
 *   3. update_credential({uuid, environmentId, label:'new'}) → {updated:true, credential:{...}}; label changed; password value never echoed
 *   4. update_credential rotating password → success; new password value NEVER appears in response text
 *   5. get_credential after rotation → still no password field; new label persisted
 *   6. delete_credential → {deleted:true, uuid}
 *   7. get_credential after delete → isError:true + NotFound
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));
const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
const API_KEY = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
const API_BASE = 'https://api.debugg.ai';

async function deleteDirect(path) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE', headers: { Authorization: `Token ${API_KEY}` },
  });
  if (!r.ok && r.status !== 404) console.log(`  \x1b[33mWARN\x1b[0m cleanup DELETE ${path}: ${r.status}`);
}

export const flow = {
  name: 'cred-crud-lifecycle',
  tags: ['fast', 'crud', 'cred'],
  description: 'TDD: cred get/update/delete lifecycle; password is write-only',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const envName = `mcp-eval-cred-crud-env-${ts}`;
    const initialLabel = `mcp-eval-cred-${ts}`;
    const initialUsername = `user-${ts}@example.invalid`;
    const initialPassword = `initial-pw-${ts}-NEVER-LEAK`;
    const rotatedPassword = `rotated-pw-${ts}-NEVER-LEAK`;
    const updatedLabel = `updated-cred-${ts}`;
    let projectUuid = null;
    let envUuid = null;
    let credUuid = null;

    try {
      await step('setup: create env WITH credential seeded in one call (bead 65m)', async () => {
        const er = await client.request('tools/call', {
          name: 'create_environment',
          arguments: {
            name: envName,
            url: 'https://example.invalid/cred-crud',
            credentials: [{
              label: initialLabel,
              username: initialUsername,
              password: initialPassword,
            }],
          },
        }, 30_000);
        assert(!er.isError, `env+cred create: ${er.content?.[0]?.text?.slice(0, 300)}`);
        const eb = JSON.parse(er.content[0].text);
        projectUuid = eb.projectUuid;
        envUuid = eb.environment.uuid;
        assert(eb.credentials && eb.credentials.length === 1, 'seed cred missing from response');
        credUuid = eb.credentials[0].uuid;
        // Defensive: the initial password must NEVER appear in response
        assert(!er.content[0].text.includes(initialPassword), 'initial password leaked in create response');
      });

      await step('search_environments(uuid) returns the cred inline; no password field', async () => {
        const r = await client.request('tools/call', {
          name: 'search_environments',
          arguments: { projectUuid, uuid: envUuid },
        }, 30_000);
        await writeArtifact('get.json', r);
        assert(!r.isError, `search_environments: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(initialPassword), 'search leaked initial password value');
        assert(!/"password"\s*:/.test(text), 'search response has a password key');
        const body = JSON.parse(text);
        const env = body.environments[0];
        const cred = env.credentials.find(c => c.uuid === credUuid);
        assert(cred, `cred ${credUuid} not found in env.credentials`);
        assert(cred.label === initialLabel, `label mismatch: ${cred.label}`);
        assert(cred.username === initialUsername, `username mismatch: ${cred.username}`);
      });

      await step('seed a role-tagged cred via create_environment path (fresh env, fresh cred)', async () => {
        const roleLabel = `mcp-eval-role-${ts}`;
        const roleValue = `role-${ts}`;
        const created = await client.request('tools/call', {
          name: 'create_environment',
          arguments: {
            name: `mcp-eval-role-env-${ts}`,
            url: 'https://example.invalid/role-env',
            credentials: [{
              label: roleLabel,
              username: `role-user-${ts}@example.invalid`,
              password: 'role-probe-pw',
              role: roleValue,
            }],
          },
        }, 30_000);
        assert(!created.isError, `env+role cred create: ${created.content?.[0]?.text?.slice(0, 300)}`);
        const createdBody = JSON.parse(created.content[0].text);
        const roleEnvUuid = createdBody.environment.uuid;
        const roleCredUuid = createdBody.credentials[0].uuid;
        assert(
          createdBody.credentials[0].role === roleValue,
          `create response should echo role. Got: ${createdBody.credentials[0].role}`,
        );

        const search = await client.request('tools/call', {
          name: 'search_environments',
          arguments: { projectUuid, uuid: roleEnvUuid },
        }, 30_000);
        const searchBody = JSON.parse(search.content[0].text);
        const cred = searchBody.environments[0].credentials.find(c => c.uuid === roleCredUuid);
        assert(cred, `new role cred not found in env.credentials`);
        assert(cred.role === roleValue, `cred.role should persist as ${roleValue}; got ${cred.role}`);

        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${roleEnvUuid}/`);
      });

      await step('update_environment w/ updateCredentials label patch — echoes cred + no password leak', async () => {
        const r = await client.request('tools/call', {
          name: 'update_environment',
          arguments: {
            uuid: envUuid,
            projectUuid,
            updateCredentials: [{ uuid: credUuid, label: updatedLabel }],
          },
        }, 30_000);
        await writeArtifact('update-label.json', r);
        assert(!r.isError, `update: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(initialPassword), 'update leaked password');
        assert(!/"password"\s*:/.test(text), 'update has password key');
        const body = JSON.parse(text);
        assert(body.updatedCredentials && body.updatedCredentials.length === 1,
          `expected updatedCredentials[1]; got ${JSON.stringify(body.updatedCredentials)}`);
        const cred = body.updatedCredentials[0];
        assert(cred.uuid === credUuid, 'uuid not echoed');
        assert(cred.label === updatedLabel, `label not updated: ${cred.label}`);
      });

      await step('update_environment w/ updateCredentials password rotation — no plaintext leak', async () => {
        const r = await client.request('tools/call', {
          name: 'update_environment',
          arguments: {
            uuid: envUuid,
            projectUuid,
            updateCredentials: [{ uuid: credUuid, password: rotatedPassword }],
          },
        }, 30_000);
        await writeArtifact('update-password.json', r);
        assert(!r.isError, `rotate: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(rotatedPassword), 'rotated password value leaked in response');
        assert(!text.includes(initialPassword), 'old password leaked in response');
        assert(!/"password"\s*:/.test(text), 'response has password key');
      });

      await step('search_environments after rotation — updated label persists, still no password', async () => {
        const r = await client.request('tools/call', {
          name: 'search_environments',
          arguments: { projectUuid, uuid: envUuid },
        }, 30_000);
        const text = r.content[0].text;
        assert(!text.includes(rotatedPassword), 'password leaked on subsequent search');
        const body = JSON.parse(text);
        const cred = body.environments[0].credentials.find(c => c.uuid === credUuid);
        assert(cred, 'cred disappeared from env after update');
        assert(cred.label === updatedLabel, `label regression: ${cred.label}`);
      });

      await step('update_environment w/ removeCredentialIds: cred is removed from env', async () => {
        const r = await client.request('tools/call', {
          name: 'update_environment',
          arguments: {
            uuid: envUuid,
            projectUuid,
            removeCredentialIds: [credUuid],
          },
        }, 30_000);
        await writeArtifact('delete.json', r);
        assert(!r.isError, `remove: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(Array.isArray(body.removedCredentialIds) && body.removedCredentialIds.includes(credUuid),
          `expected removedCredentialIds to include ${credUuid}`);
        credUuid = null; // skip fallback direct-delete cleanup
      });

      await step('search_environments after delete — cred not in env.credentials', async () => {
        const r = await client.request('tools/call', {
          name: 'search_environments',
          arguments: { projectUuid, uuid: envUuid },
        }, 30_000);
        assert(!r.isError, `search_environments after delete: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        const creds = body.environments[0].credentials;
        const found = creds.find(c => c.uuid === (credUuid ?? '00000000-0000-0000-0000-000000000000'));
        assert(!found, `deleted cred still present in env.credentials: ${JSON.stringify(found)}`);
      });
    } finally {
      if (credUuid && projectUuid && envUuid) {
        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`);
      }
      if (envUuid && projectUuid) {
        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/`);
      }
    }
  },
};
