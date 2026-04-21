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
      await step('setup: create env + credential via existing tools', async () => {
        const er = await client.request('tools/call', {
          name: 'create_environment',
          arguments: { name: envName, url: 'https://example.invalid/cred-crud' },
        }, 30_000);
        assert(!er.isError, `env create: ${er.content?.[0]?.text?.slice(0, 300)}`);
        const eb = JSON.parse(er.content[0].text);
        projectUuid = eb.projectUuid; envUuid = eb.environment.uuid;

        const cr = await client.request('tools/call', {
          name: 'create_credential',
          arguments: {
            environmentId: envUuid,
            label: initialLabel,
            username: initialUsername,
            password: initialPassword,
          },
        }, 30_000);
        assert(!cr.isError, `cred create: ${cr.content?.[0]?.text?.slice(0, 300)}`);
        credUuid = JSON.parse(cr.content[0].text).credential.uuid;
      });

      await step('get_credential returns full cred by uuid; no password field', async () => {
        const r = await client.request('tools/call', {
          name: 'get_credential',
          arguments: { uuid: credUuid, environmentId: envUuid },
        }, 30_000);
        await writeArtifact('get.json', r);
        assert(!r.isError, `get_credential error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(initialPassword), 'get_credential leaked initial password value');
        assert(!/"password"/.test(text), 'get_credential response has a password key');
        const body = JSON.parse(text);
        assert(body.credential.uuid === credUuid, `uuid mismatch: ${body.credential.uuid}`);
        assert(body.credential.label === initialLabel, `label mismatch: ${body.credential.label}`);
        assert(body.credential.username === initialUsername, `username mismatch: ${body.credential.username}`);
        assert(body.credential.environmentUuid === envUuid, `envUuid mismatch: ${body.credential.environmentUuid}`);
      });

      await step('create_credential with role, round-trip via get + filter by role (hpo backend fix)', async () => {
        const roleLabel = `mcp-eval-role-${ts}`;
        const roleValue = `role-${ts}`;
        const created = await client.request('tools/call', {
          name: 'create_credential',
          arguments: {
            environmentId: envUuid,
            label: roleLabel,
            username: `role-user-${ts}@example.invalid`,
            password: 'role-probe-pw',
            role: roleValue,
          },
        }, 30_000);
        assert(!created.isError, `create with role: ${created.content?.[0]?.text?.slice(0, 300)}`);
        const createdBody = JSON.parse(created.content[0].text);
        const roleCredUuid = createdBody.credential.uuid;
        assert(
          createdBody.credential.role === roleValue,
          `create response should echo role. Got: ${createdBody.credential.role}`
        );

        const got = await client.request('tools/call', {
          name: 'get_credential',
          arguments: { uuid: roleCredUuid, environmentId: envUuid },
        }, 30_000);
        const gotBody = JSON.parse(got.content[0].text);
        assert(
          gotBody.credential.role === roleValue,
          `get should round-trip role. Got: ${gotBody.credential.role}`
        );

        const filtered = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid, role: roleValue },
        }, 30_000);
        const filteredBody = JSON.parse(filtered.content[0].text);
        assert(
          filteredBody.credentials.some(c => c.uuid === roleCredUuid),
          `list_credentials role=${roleValue} should include the new cred`
        );
        assert(
          filteredBody.credentials.every(c => c.role === roleValue),
          `list_credentials role filter returned non-matching creds`
        );

        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${roleCredUuid}/`);
      });

      await step('update_credential patches label; response echoes uuid + new label; no password leak', async () => {
        const r = await client.request('tools/call', {
          name: 'update_credential',
          arguments: { uuid: credUuid, environmentId: envUuid, label: updatedLabel },
        }, 30_000);
        await writeArtifact('update-label.json', r);
        assert(!r.isError, `update: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(initialPassword), 'update leaked password');
        assert(!/"password"/.test(text), 'update has password key');
        const body = JSON.parse(text);
        assert(body.updated === true, 'missing updated:true');
        assert(body.credential.uuid === credUuid, 'uuid not echoed');
        assert(body.credential.label === updatedLabel, `label not updated: ${body.credential.label}`);
      });

      await step('update_credential rotating password — response never contains plaintext password', async () => {
        const r = await client.request('tools/call', {
          name: 'update_credential',
          arguments: { uuid: credUuid, environmentId: envUuid, password: rotatedPassword },
        }, 30_000);
        await writeArtifact('update-password.json', r);
        assert(!r.isError, `rotate: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const text = r.content[0].text;
        assert(!text.includes(rotatedPassword), 'rotated password value leaked in response');
        assert(!text.includes(initialPassword), 'old password leaked in response');
        assert(!/"password"/.test(text), 'response has password key');
      });

      await step('get_credential after rotation — updated label persists, still no password', async () => {
        const r = await client.request('tools/call', {
          name: 'get_credential',
          arguments: { uuid: credUuid, environmentId: envUuid },
        }, 30_000);
        const text = r.content[0].text;
        assert(!text.includes(rotatedPassword), 'password leaked on subsequent get');
        const body = JSON.parse(text);
        assert(body.credential.label === updatedLabel, `label regression: ${body.credential.label}`);
      });

      await step('delete_credential removes cred and returns {deleted:true, uuid}', async () => {
        const r = await client.request('tools/call', {
          name: 'delete_credential',
          arguments: { uuid: credUuid, environmentId: envUuid },
        }, 30_000);
        await writeArtifact('delete.json', r);
        assert(!r.isError, `delete: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.deleted === true, 'missing deleted:true');
        assert(body.uuid === credUuid, `uuid mismatch: ${body.uuid}`);
        credUuid = null; // skip cleanup
      });

      await step('get_credential on deleted uuid returns NotFound (isError:true)', async () => {
        const r = await client.request('tools/call', {
          name: 'get_credential',
          arguments: {
            uuid: credUuid ?? '00000000-0000-0000-0000-000000000000',
            environmentId: envUuid,
          },
        }, 30_000);
        assert(r.isError === true, 'expected isError:true on deleted uuid');
        const body = JSON.parse(r.content[0].text);
        assert(
          /not.?found/i.test((body.error ?? '') + ' ' + (body.message ?? '')),
          `expected NotFound, got: ${JSON.stringify(body).slice(0, 200)}`
        );
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
