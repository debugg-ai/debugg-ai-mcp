/**
 * trigger_crawl with a projectUuid — the happy path for KG import.
 *
 * Flows 23 and 24 deliberately omit projectUuid so the backend skips KG import
 * with reason='no_environment' (safe for evals: no writes to real project state).
 * This flow completes the coverage: create a throwaway project (which gets an
 * auto-provisioned Default Runner Environment), fire trigger_crawl against
 * example.com scoped to that project, and assert:
 *   - knowledgeGraph.imported === true
 *   - knowledgeGraph.skipped === false
 *   - knowledgeGraph.reason !== 'no_environment'
 *   - statesImported > 0 (actual data landed)
 *   - knowledgeGraphId is a non-empty string
 *
 * Cleanup: delete_project (cascades project-scoped data; best-effort direct
 * DELETE fallback if the MCP-layer call fails).
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));

const TARGET_URL = 'https://example.com';

async function fetchTeamName() {
  const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
  const TOKEN = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
  const BASE = process.env.DEBUGGAI_API_URL || 'https://api.debugg.ai';
  const out = execSync(
    `curl -sH "Authorization: Token ${TOKEN}" "${BASE}/api/v1/teams/?page_size=1"`,
    { encoding: 'utf8' },
  );
  return JSON.parse(out).results?.[0]?.name;
}

async function deleteProjectDirect(projectUuid) {
  const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
  const TOKEN = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
  const BASE = process.env.DEBUGGAI_API_URL || 'https://api.debugg.ai';
  try {
    execSync(
      `curl -sfH "Authorization: Token ${TOKEN}" -X DELETE "${BASE}/api/v1/projects/${projectUuid}/" > /dev/null`,
      { encoding: 'utf8' },
    );
  } catch { /* best-effort */ }
}

export const flow = {
  name: 'crawl-trigger-with-project',
  tags: ['browser', 'browser-public', 'crawl', 'project-mgmt'],
  description: 'trigger_crawl with projectUuid proves KG import actually lands data',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    let projectUuid = null;
    let response = null;

    try {
      await step('setup: create throwaway project (auto-provisions Default Runner Environment)', async () => {
        const teamName = await fetchTeamName();
        assert(teamName, 'No team available via backend probe');

        const projectsResp = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { pageSize: 5 },
        }, 30_000);
        const projects = JSON.parse(projectsResp.content[0].text).projects;
        const repoName = projects.find(p => p.repoName)?.repoName;
        assert(repoName, 'No project with a discoverable repoName found');

        const created = await client.request('tools/call', {
          name: 'create_project',
          arguments: {
            name: `mcp-eval-crawl-kg-${ts}`,
            platform: 'web',
            teamName,
            repoName,
          },
        }, 30_000);
        assert(!created.isError, `create_project: ${created.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(created.content[0].text);
        projectUuid = body.project.uuid;
        console.log(`  \x1b[2mcreated test project: ${projectUuid}\x1b[0m`);
      });

      await step(`trigger_crawl(url=${TARGET_URL}, projectUuid=${'<created>'}) reaches terminal status`, async () => {
        response = await client.request('tools/call', {
          name: 'trigger_crawl',
          arguments: { url: TARGET_URL, projectUuid },
        }, 660_000);
        await writeArtifact('raw-response.json', response);
        assert(!response.isError, `trigger_crawl: ${response.content?.[0]?.text?.slice(0, 400)}`);
        const body = JSON.parse(response.content[0].text);
        await writeArtifact('body.json', body);
        assert(body.status === 'completed', `expected status=completed, got ${body.status}`);
      });

      await step('crawlSummary proves the crawl actually performed work', async () => {
        const body = JSON.parse(response.content[0].text);
        assert(body.crawlSummary, `Missing crawlSummary`);
        assert(body.crawlSummary.success === true,
          `crawlSummary.success not true: ${body.crawlSummary.success}`);
        assert(body.crawlSummary.pagesDiscovered >= 1,
          `crawlSummary.pagesDiscovered must be >= 1; got ${body.crawlSummary.pagesDiscovered}`);
      });

      await step('knowledgeGraph.imported === true — THIS IS THE BEAD 9dy PROOF POINT', async () => {
        const body = JSON.parse(response.content[0].text);
        assert(body.knowledgeGraph, `Missing knowledgeGraph block`);
        assert(
          body.knowledgeGraph.imported === true,
          `KG import did NOT run. Got: ${JSON.stringify(body.knowledgeGraph)}. ` +
          `This usually means the project has no default environment, or the backend's EnvironmentResolver failed.`,
        );
        assert(
          body.knowledgeGraph.skipped === false,
          `knowledgeGraph.skipped must be false; got ${body.knowledgeGraph.skipped}`,
        );
        assert(
          body.knowledgeGraph.reason !== 'no_environment',
          `KG reason must not be 'no_environment' when projectUuid provided; got '${body.knowledgeGraph.reason}'`,
        );
      });

      await step('KG data actually landed: statesImported > 0, valid knowledgeGraphId', async () => {
        const body = JSON.parse(response.content[0].text);
        assert(
          typeof body.knowledgeGraph.statesImported === 'number' && body.knowledgeGraph.statesImported > 0,
          `statesImported must be > 0; got ${body.knowledgeGraph.statesImported}`,
        );
        assert(
          typeof body.knowledgeGraph.knowledgeGraphId === 'string' && body.knowledgeGraph.knowledgeGraphId.length > 0,
          `knowledgeGraphId must be a non-empty string; got "${body.knowledgeGraph.knowledgeGraphId}"`,
        );
      });
    } finally {
      if (projectUuid) {
        // Prefer MCP delete_project; fall back to direct DELETE if MCP layer fails
        try {
          const del = await client.request('tools/call', {
            name: 'delete_project',
            arguments: { uuid: projectUuid },
          }, 30_000);
          if (del.isError) {
            console.log(`  \x1b[33mWARN\x1b[0m delete_project via MCP failed, falling back to direct API`);
            await deleteProjectDirect(projectUuid);
          }
        } catch {
          await deleteProjectDirect(projectUuid);
        }
      }
    }
  },
};
