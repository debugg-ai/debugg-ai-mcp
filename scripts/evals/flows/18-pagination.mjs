/**
 * TDD red: every list_* tool must expose pagination with a consistent
 * pageInfo shape. Currently all 4 tools silently truncate to the first page.
 *
 * Green definition:
 *   - Every list tool accepts {page?, pageSize?} inputs.
 *   - Every list tool response contains:
 *       pageInfo: { page, pageSize, totalCount, totalPages, hasMore }
 *       filter:   { ...inputs echoed }
 *       <resourceArray>: [...]
 *   - Default pageSize is 20 (not whatever the backend happens to use).
 *   - pageSize > 200 is clamped to 200 (matches backend cap).
 *   - Pages walk forward consistently (page 1 items ∩ page 2 items = ∅).
 *
 * Coverage:
 *   - list_projects: real account has >10 projects, probed directly.
 *   - list_executions: real account has thousands, probed directly.
 *   - list_environments + list_credentials: create 5 throwaway resources,
 *     exercise pagination with pageSize=2, clean up.
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

function assertPageInfo(assert, body, expected) {
  assert(body.pageInfo, 'response missing pageInfo');
  const pi = body.pageInfo;
  assert(typeof pi.page === 'number', 'pageInfo.page missing or not a number');
  assert(typeof pi.pageSize === 'number', 'pageInfo.pageSize missing or not a number');
  assert(typeof pi.totalCount === 'number', 'pageInfo.totalCount missing or not a number');
  assert(typeof pi.totalPages === 'number', 'pageInfo.totalPages missing or not a number');
  assert(typeof pi.hasMore === 'boolean', 'pageInfo.hasMore missing or not a boolean');
  if (expected.page !== undefined) assert(pi.page === expected.page, `page ${pi.page} !== ${expected.page}`);
  if (expected.pageSize !== undefined) assert(pi.pageSize === expected.pageSize, `pageSize ${pi.pageSize} !== ${expected.pageSize}`);
}

export const flow = {
  name: 'pagination',
  description: 'Every list_* tool must expose page/pageSize inputs and return pageInfo',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();

    // ─── list_projects ─────────────────────────────────────────────────────
    await step('list_projects — default page 1, pageSize 20', async () => {
      const r = await client.request('tools/call', { name: 'list_projects', arguments: {} }, 30_000);
      await writeArtifact('projects-default.json', r);
      assert(!r.isError, `list_projects: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assertPageInfo(assert, body, { page: 1, pageSize: 20 });
      assert(body.projects.length <= 20, `default page exceeded 20 items: ${body.projects.length}`);
    });

    await step('list_projects — page 1 vs page 2 are disjoint with pageSize=3', async () => {
      const p1 = await client.request('tools/call', { name: 'list_projects', arguments: { page: 1, pageSize: 3 } }, 30_000);
      const p2 = await client.request('tools/call', { name: 'list_projects', arguments: { page: 2, pageSize: 3 } }, 30_000);
      await writeArtifact('projects-p1.json', p1);
      await writeArtifact('projects-p2.json', p2);
      const b1 = JSON.parse(p1.content[0].text);
      const b2 = JSON.parse(p2.content[0].text);
      assertPageInfo(assert, b1, { page: 1, pageSize: 3 });
      assertPageInfo(assert, b2, { page: 2, pageSize: 3 });
      assert(b1.projects.length === 3, `p1 expected 3 items got ${b1.projects.length}`);
      const p1Uuids = new Set(b1.projects.map(p => p.uuid));
      const overlap = b2.projects.filter(p => p1Uuids.has(p.uuid));
      assert(overlap.length === 0, `p1 ∩ p2 should be empty, got ${overlap.length} overlap`);
      assert(b1.pageInfo.hasMore === true, 'p1.hasMore should be true with 125+ projects and pageSize=3');
    });

    await step('list_projects — pageSize > 200 clamps to 200', async () => {
      const r = await client.request('tools/call', { name: 'list_projects', arguments: { pageSize: 10000 } }, 30_000);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.pageSize === 200, `pageSize should clamp to 200, got ${body.pageInfo.pageSize}`);
    });

    // ─── list_executions ───────────────────────────────────────────────────
    await step('list_executions — default pageSize 20; pagination walks forward', async () => {
      const p1 = await client.request('tools/call', { name: 'list_executions', arguments: { pageSize: 5 } }, 30_000);
      const p2 = await client.request('tools/call', { name: 'list_executions', arguments: { page: 2, pageSize: 5 } }, 30_000);
      await writeArtifact('executions-p1.json', p1);
      const b1 = JSON.parse(p1.content[0].text);
      const b2 = JSON.parse(p2.content[0].text);
      assertPageInfo(assert, b1, { page: 1, pageSize: 5 });
      assertPageInfo(assert, b2, { page: 2, pageSize: 5 });
      assert(b1.executions.length === 5, `p1 exec count ${b1.executions.length}`);
      const overlap = b2.executions.filter(e => b1.executions.some(x => x.uuid === e.uuid));
      assert(overlap.length === 0, `exec p1∩p2 overlap: ${overlap.length}`);
    });

    // ─── list_environments ─────────────────────────────────────────────────
    const createdEnvs = [];
    let envProjectUuid = null;
    try {
      await step('setup: create 5 throwaway envs for env pagination', async () => {
        for (let i = 0; i < 5; i++) {
          const r = await client.request('tools/call', {
            name: 'create_environment',
            arguments: { name: `mcp-eval-page-${ts}-${i}`, url: `https://example.invalid/page-${i}` },
          }, 30_000);
          assert(!r.isError, `env create ${i}: ${r.content?.[0]?.text?.slice(0, 200)}`);
          const body = JSON.parse(r.content[0].text);
          envProjectUuid = body.projectUuid;
          createdEnvs.push(body.environment.uuid);
        }
      });

      await step('list_environments — pageSize=2, walk page 1, 2, 3', async () => {
        const all = new Set();
        for (let page = 1; page <= 3; page++) {
          const r = await client.request('tools/call', {
            name: 'list_environments',
            arguments: { page, pageSize: 2 },
          }, 30_000);
          await writeArtifact(`envs-p${page}.json`, r);
          const body = JSON.parse(r.content[0].text);
          assertPageInfo(assert, body, { page, pageSize: 2 });
          for (const e of body.environments) {
            assert(!all.has(e.uuid), `env ${e.uuid} appeared on multiple pages`);
            all.add(e.uuid);
          }
        }
        assert(all.size >= 6, `expected >=6 envs across 3 pages, got ${all.size}`); // 5 created + 1 default
      });
    } finally {
      for (const uuid of createdEnvs) {
        if (envProjectUuid) await deleteDirect(`/api/v1/projects/${envProjectUuid}/environments/${uuid}/`);
      }
    }

    // ─── list_credentials ──────────────────────────────────────────────────
    const credSetupEnv = { projectUuid: null, envUuid: null, credUuids: [] };
    try {
      await step('setup: create env + 5 creds for cred pagination', async () => {
        const envResp = await client.request('tools/call', {
          name: 'create_environment',
          arguments: { name: `mcp-eval-cred-page-${ts}`, url: 'https://example.invalid/cred-page' },
        }, 30_000);
        const envBody = JSON.parse(envResp.content[0].text);
        credSetupEnv.projectUuid = envBody.projectUuid;
        credSetupEnv.envUuid = envBody.environment.uuid;

        for (let i = 0; i < 5; i++) {
          const r = await client.request('tools/call', {
            name: 'create_credential',
            arguments: {
              environmentId: credSetupEnv.envUuid,
              label: `mcp-eval-cred-page-${ts}-${i}`,
              username: `cp-${ts}-${i}@x.y`,
              password: 'p',
            },
          }, 30_000);
          const b = JSON.parse(r.content[0].text);
          credSetupEnv.credUuids.push(b.credential.uuid);
        }
      });

      await step('list_credentials — pageSize=2, walk page 1, 2, 3', async () => {
        const all = new Set();
        for (let page = 1; page <= 3; page++) {
          const r = await client.request('tools/call', {
            name: 'list_credentials',
            arguments: { environmentId: credSetupEnv.envUuid, page, pageSize: 2 },
          }, 30_000);
          await writeArtifact(`creds-p${page}.json`, r);
          const body = JSON.parse(r.content[0].text);
          assertPageInfo(assert, body, { page, pageSize: 2 });
          for (const c of body.credentials) {
            assert(!all.has(c.uuid), `cred ${c.uuid} appeared on multiple pages`);
            all.add(c.uuid);
          }
        }
        assert(all.size === 5, `expected all 5 creds across pages, got ${all.size}`);
      });
    } finally {
      for (const uuid of credSetupEnv.credUuids) {
        await deleteDirect(`/api/v1/projects/${credSetupEnv.projectUuid}/environments/${credSetupEnv.envUuid}/credentials/${uuid}/`);
      }
      if (credSetupEnv.envUuid) {
        await deleteDirect(`/api/v1/projects/${credSetupEnv.projectUuid}/environments/${credSetupEnv.envUuid}/`);
      }
    }
  },
};
