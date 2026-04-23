/**
 * create_project end-to-end. Exercises the name-resolution path introduced in
 * bead 9gh: creates a project from teamName + repoName (no separate
 * list_teams / list_repos discovery calls).
 *
 * Green definition:
 *   1. create_project({name, platform, teamName, repoName}) → resolves both and creates
 *   2. search_projects(uuid=new project uuid) confirms it exists
 *   3. cleanup: delete_project + search_projects returns NotFound
 *   4. create_project with bogus teamName → isError:true TeamNotFound (no project created)
 *
 * Sources teamName + repoName from the backend via a one-time probe of
 * search_projects (which returns repo.name inside each project row) and a
 * curl-style direct API call for teams (since list_teams is gone).
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(dirname(HERE)));

async function fetchTeamName() {
  // Direct backend probe — we don't expose a teams tool anymore.
  const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
  const TOKEN = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
  const BASE = process.env.DEBUGGAI_API_URL || 'https://api.debugg.ai';
  const out = execSync(
    `curl -sH "Authorization: Token ${TOKEN}" "${BASE}/api/v1/teams/?page_size=1"`,
    { encoding: 'utf8' },
  );
  const body = JSON.parse(out);
  return body.results?.[0]?.name;
}

async function deleteDirect(projectUuid) {
  const testConfig = JSON.parse(readFileSync(join(ROOT, 'test-config.json'), 'utf-8'));
  const TOKEN = testConfig.mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
  const BASE = process.env.DEBUGGAI_API_URL || 'https://api.debugg.ai';
  execSync(
    `curl -sfH "Authorization: Token ${TOKEN}" -X DELETE "${BASE}/api/v1/projects/${projectUuid}/" > /dev/null`,
    { encoding: 'utf8' },
  );
}

export const flow = {
  name: 'project-create',
  tags: ['fast', 'crud', 'project'],
  description: 'create_project via teamName/repoName resolution; cleanup via delete_project',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    let createdProjectUuid = null;
    let teamName = null;
    let repoName = null;

    try {
      await step('setup: discover a teamName (direct API) + repoName (via search_projects)', async () => {
        teamName = await fetchTeamName();
        assert(teamName, 'No teams found via backend probe');

        const projectsResp = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { pageSize: 5 },
        }, 30_000);
        const projects = JSON.parse(projectsResp.content[0].text).projects;
        const first = projects.find(p => p.repoName);
        assert(first, 'No project with a repoName found to probe');
        repoName = first.repoName;
      });

      await step('create_project via teamName + repoName — resolves + creates', async () => {
        const name = `mcp-eval-create-proj-${ts}`;
        const r = await client.request('tools/call', {
          name: 'create_project',
          arguments: { name, platform: 'web', teamName, repoName },
        }, 30_000);
        await writeArtifact('create.json', r);
        assert(!r.isError, `create_project: ${r.content?.[0]?.text?.slice(0, 400)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.created === true, 'response missing created:true');
        assert(body.project, 'response missing .project');
        assert(typeof body.project.uuid === 'string', 'project.uuid missing');
        assert(body.project.name === name, `name mismatch: ${body.project.name}`);
        assert(body.project.platform === 'web', `platform mismatch: ${body.project.platform}`);
        createdProjectUuid = body.project.uuid;
      });

      await step('search_projects(uuid) on newly-created uuid succeeds', async () => {
        const r = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(!r.isError, `search_projects(uuid): ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.projects[0].uuid === createdProjectUuid, 'uuid mismatch');
      });

      await step('delete_project + search_projects returns NotFound', async () => {
        const delResp = await client.request('tools/call', {
          name: 'delete_project',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(!delResp.isError, `delete_project: ${delResp.content?.[0]?.text?.slice(0, 300)}`);
        const delBody = JSON.parse(delResp.content[0].text);
        assert(delBody.deleted === true, 'delete response missing deleted:true');

        const afterResp = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(afterResp.isError === true, 'expected isError:true after delete');
        const afterBody = JSON.parse(afterResp.content[0].text);
        assert(/not.?found/i.test((afterBody.error ?? '') + ' ' + (afterBody.message ?? '')),
          `expected NotFound after delete, got: ${JSON.stringify(afterBody).slice(0, 200)}`);
        createdProjectUuid = null; // skip fallback cleanup
      });

      await step('create_project with bogus teamName → isError:true TeamNotFound', async () => {
        const r = await client.request('tools/call', {
          name: 'create_project',
          arguments: {
            name: `mcp-eval-bogus-${ts}`,
            platform: 'web',
            teamName: 'zzz-team-should-never-match',
            repoName,
          },
        }, 30_000);
        assert(r.isError === true, 'expected isError:true');
        const body = JSON.parse(r.content[0].text);
        assert(/NotFound/.test(body.error ?? ''), `expected NotFound error, got: ${body.error}`);
      });
    } finally {
      if (createdProjectUuid) {
        await deleteDirect(createdProjectUuid).catch(() => {});
      }
    }
  },
};
