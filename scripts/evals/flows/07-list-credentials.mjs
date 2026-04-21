/**
 * list_credentials shape + no-secret-leak assertion. Creates a throwaway env
 * + cred so we always have at least one cred to inspect regardless of what's
 * pre-configured in the test account.
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
    method: 'DELETE',
    headers: { Authorization: `Token ${API_KEY}` },
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`Cleanup DELETE ${path} failed: ${r.status}`);
  }
}

export const flow = {
  name: 'list-credentials',
  tags: ['fast', 'crud', 'cred'],
  description: 'list_credentials shape, filtering, and no-secret-leak',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const envName = `mcp-eval-${ts}-env`;
    const credLabel = `mcp-eval-${ts}-cred`;
    const rolePrefixed = `mcp-eval-role-${ts}`;
    let projectUuid = null;
    let envUuid = null;
    let credUuid = null;

    try {
      await step('setup: create throwaway env + credential', async () => {
        const envResp = await client.request('tools/call', {
          name: 'create_environment',
          arguments: { name: envName, url: 'https://example.invalid/mcp-eval' },
        }, 30_000);
        assert(!envResp.isError, `env create failed: ${envResp.content?.[0]?.text?.slice(0, 300)}`);
        const envBody = JSON.parse(envResp.content[0].text);
        projectUuid = envBody.projectUuid;
        envUuid = envBody.environment.uuid;

        const credResp = await client.request('tools/call', {
          name: 'create_credential',
          arguments: {
            environmentId: envUuid,
            label: credLabel,
            username: `mcp-eval-${ts}@example.invalid`,
            password: 'should-never-appear-in-response',
            role: rolePrefixed,
          },
        }, 30_000);
        assert(!credResp.isError, `cred create failed: ${credResp.content?.[0]?.text?.slice(0, 300)}`);
        const credBody = JSON.parse(credResp.content[0].text);
        credUuid = credBody.credential.uuid;

        // Password must not appear anywhere in the create response
        const credText = credResp.content[0].text;
        assert(!credText.includes('should-never-appear-in-response'), 'create_credential response leaked raw password');
        assert(!('password' in credBody.credential), 'credential.password field should not exist');
      });

      await step('list_credentials — filter by environmentId contains the new cred', async () => {
        const r = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid },
        }, 30_000);
        await writeArtifact('by-env.json', r);
        assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        const found = body.credentials.find(c => c.uuid === credUuid);
        assert(!!found, 'Created cred not found when filtering by environmentId');
        assert(found.label === credLabel, `label mismatch: ${found.label}`);
        // NOTE: role is intentionally NOT asserted — the backend credential schema
        // does not include a role field, so it always round-trips as null.
        // See bead for backend support: credentials have no role field.
      });

      await step('list_credentials — filter by q matches the label (backend ?search= — bead 4e8)', async () => {
        const r = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid, q: credLabel },
        }, 30_000);
        await writeArtifact('by-q.json', r);
        const body = JSON.parse(r.content[0].text);
        assert(body.pageInfo.totalCount >= 1, `Expected >=1 match for q="${credLabel}"`);
        assert(body.credentials.every(c => c.label.includes(credLabel) || c.username.includes(credLabel)),
          'q filter returned non-matching credentials');

        // Lock the backend fix: a known-miss query must return 0. Before the fix
        // this returned all creds regardless of query.
        const bogus = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid, q: `zzz-never-matches-${ts}` },
        }, 30_000);
        const bogusBody = JSON.parse(bogus.content[0].text);
        assert(bogusBody.pageInfo.totalCount === 0,
          `bogus q expected totalCount=0, got ${bogusBody.pageInfo.totalCount} — 4e8 regressed`);
      });

      await step('list_credentials — no environmentId filter iterates all envs and includes new cred', async () => {
        const r = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: {},
        }, 30_000);
        await writeArtifact('all-envs.json', r);
        const body = JSON.parse(r.content[0].text);
        assert(body.filter.environmentId === null, 'filter.environmentId should be null');
        const found = body.credentials.find(c => c.uuid === credUuid);
        assert(!!found, 'Newly-created cred not found when listing across all envs');
      });

      await step('list_credentials — projectUuid override echoes correctly', async () => {
        const r = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { projectUuid, environmentId: envUuid },
        }, 30_000);
        const body = JSON.parse(r.content[0].text);
        assert(body.project.uuid === projectUuid, 'project.uuid did not echo the override');
        assert(body.filter.environmentId === envUuid, 'filter.environmentId wrong');
      });

      await step('create_credential — minimal inputs (no role) also round-trips', async () => {
        const minimalLabel = `mcp-eval-minimal-${ts}`;
        const minimalResp = await client.request('tools/call', {
          name: 'create_credential',
          arguments: {
            environmentId: envUuid,
            label: minimalLabel,
            username: `minimal-${ts}@example.invalid`,
            password: 'minimal-secret-no-leak',
          },
        }, 30_000);
        assert(!minimalResp.isError, `minimal create failed: ${minimalResp.content?.[0]?.text?.slice(0, 300)}`);
        const minimalBody = JSON.parse(minimalResp.content[0].text);
        const minimalUuid = minimalBody.credential.uuid;
        const minimalText = minimalResp.content[0].text;
        assert(!minimalText.includes('minimal-secret-no-leak'), 'minimal create leaked password');

        // Verify it shows up, then clean up
        const listResp = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid, q: minimalLabel },
        }, 30_000);
        const listBody = JSON.parse(listResp.content[0].text);
        assert(listBody.pageInfo.totalCount >= 1, `minimal cred not findable by q="${minimalLabel}"`);

        await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${minimalUuid}/`);
      });

      await step('list_credentials — no password/secret fields anywhere in response', async () => {
        const r = await client.request('tools/call', {
          name: 'list_credentials',
          arguments: { environmentId: envUuid },
        }, 30_000);
        const text = r.content[0].text.toLowerCase();
        assert(!text.includes('"password"'), 'Response contains "password" key');
        assert(!text.includes('"secret"'), 'Response contains "secret" key');
        assert(!text.includes('should-never-appear'), 'Response leaked the password value');
      });
    } finally {
      if (credUuid && projectUuid && envUuid) {
        try {
          await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/credentials/${credUuid}/`);
          console.log(`  \x1b[2mcleanup: deleted cred ${credUuid}\x1b[0m`);
        } catch (e) {
          console.log(`  \x1b[33mWARN\x1b[0m cred cleanup failed: ${e.message}`);
        }
      }
      if (envUuid && projectUuid) {
        try {
          await deleteDirect(`/api/v1/projects/${projectUuid}/environments/${envUuid}/`);
          console.log(`  \x1b[2mcleanup: deleted env ${envUuid}\x1b[0m`);
        } catch (e) {
          console.log(`  \x1b[33mWARN\x1b[0m env cleanup failed: ${e.message}`);
        }
      }
    }
  },
};
