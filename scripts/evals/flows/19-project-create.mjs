/**
 * TDD red: list_teams, list_repos, create_project don't exist yet.
 *
 * Context: POST /api/v1/projects/ requires {name, platform, team, repo} with
 * team and repo being UUIDs already linked to the account. This flow adds
 * two helper tools to discover those UUIDs (list_teams, list_repos), then
 * exercises create_project end-to-end.
 *
 * Green definition:
 *   1. list_teams → {pageInfo, teams:[{uuid,name,...}]}
 *   2. list_repos → {pageInfo, repos:[{uuid,name,url,isGithubAuthorized,...}]}
 *   3. create_project({name, platform, teamUuid, repoUuid}) → {created:true, project:{uuid,name,slug,platform,repoName,...}}
 *   4. get_project on the new uuid confirms it exists
 *   5. cleanup: delete_project (verified by get returning NotFound)
 */

export const flow = {
  name: 'project-create',
  description: 'TDD: list_teams + list_repos + create_project end-to-end, with delete cleanup',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    let teamUuid = null;
    let repoUuid = null;
    let createdProjectUuid = null;

    try {
      await step('list_teams returns paginated teams with real shape', async () => {
        const r = await client.request('tools/call', { name: 'list_teams', arguments: {} }, 30_000);
        await writeArtifact('teams.json', r);
        assert(!r.isError, `list_teams: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.pageInfo, 'response missing pageInfo');
        assert(Array.isArray(body.teams), 'teams not an array');
        assert(body.teams.length >= 1, `expected >=1 team, got ${body.teams.length}`);
        for (const t of body.teams) {
          assert(typeof t.uuid === 'string', 'team.uuid missing');
          assert(typeof t.name === 'string', 'team.name missing');
        }
        teamUuid = body.teams[0].uuid;
      });

      await step('list_repos returns paginated repos with real shape', async () => {
        const r = await client.request('tools/call', { name: 'list_repos', arguments: { pageSize: 5 } }, 30_000);
        await writeArtifact('repos.json', r);
        assert(!r.isError, `list_repos: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.pageInfo, 'response missing pageInfo');
        assert(Array.isArray(body.repos), 'repos not an array');
        assert(body.repos.length >= 1, `expected >=1 repo, got ${body.repos.length}`);
        for (const r of body.repos) {
          assert(typeof r.uuid === 'string', 'repo.uuid missing');
          assert(typeof r.name === 'string', 'repo.name missing');
          assert(typeof r.isGithubAuthorized === 'boolean', 'repo.isGithubAuthorized missing');
        }
        // Prefer a github-authorized repo since the backend needs installation linkage
        const authed = body.repos.find(r => r.isGithubAuthorized) ?? body.repos[0];
        repoUuid = authed.uuid;
      });

      await step('list_repos — q filter via server-side search', async () => {
        // Pull a known repo name then filter by substring
        const unfiltered = await client.request('tools/call', { name: 'list_repos', arguments: { pageSize: 1 } }, 30_000);
        const firstName = JSON.parse(unfiltered.content[0].text).repos[0].name;
        const needle = firstName.slice(0, Math.min(4, firstName.length));
        const filtered = await client.request('tools/call', { name: 'list_repos', arguments: { q: needle, pageSize: 5 } }, 30_000);
        const body = JSON.parse(filtered.content[0].text);
        assert(body.pageInfo.totalCount >= 1, `expected >=1 match for q="${needle}"`);

        const bogus = await client.request('tools/call', { name: 'list_repos', arguments: { q: 'zzz-never-matches-repo', pageSize: 5 } }, 30_000);
        const bogusBody = JSON.parse(bogus.content[0].text);
        assert(bogusBody.pageInfo.totalCount === 0, `bogus q expected 0 got ${bogusBody.pageInfo.totalCount}`);
      });

      await step(`create_project with name + platform=web + teamUuid + repoUuid returns 201-shape`, async () => {
        const name = `mcp-eval-create-proj-${ts}`;
        const r = await client.request('tools/call', {
          name: 'create_project',
          arguments: { name, platform: 'web', teamUuid, repoUuid },
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

      await step('get_project on newly-created uuid succeeds', async () => {
        const r = await client.request('tools/call', {
          name: 'get_project',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(!r.isError, `get_project: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.project.uuid === createdProjectUuid, 'uuid mismatch');
      });

      await step('delete_project cleans up + get_project returns NotFound', async () => {
        const delResp = await client.request('tools/call', {
          name: 'delete_project',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(!delResp.isError, `delete_project: ${delResp.content?.[0]?.text?.slice(0, 300)}`);
        const delBody = JSON.parse(delResp.content[0].text);
        assert(delBody.deleted === true, 'delete response missing deleted:true');

        const afterResp = await client.request('tools/call', {
          name: 'get_project',
          arguments: { uuid: createdProjectUuid },
        }, 30_000);
        assert(afterResp.isError === true, 'expected isError:true after delete');
        const afterBody = JSON.parse(afterResp.content[0].text);
        assert(/not.?found/i.test((afterBody.error ?? '') + ' ' + (afterBody.message ?? '')),
          `expected NotFound after delete, got: ${JSON.stringify(afterBody).slice(0, 200)}`);
        createdProjectUuid = null; // skip fallback cleanup
      });
    } finally {
      if (createdProjectUuid) {
        // Fallback: direct-API delete in case flow failed mid-way
        const { readFileSync: rf } = await import('fs');
        const { fileURLToPath: fu } = await import('url');
        const { dirname: dn, join: jn } = await import('path');
        const here = dn(fu(import.meta.url));
        const root = dn(dn(dn(here)));
        const key = JSON.parse(rf(jn(root, 'test-config.json'), 'utf-8')).mcpServers['debugg-ai-mcp-node'].env.DEBUGGAI_API_KEY;
        await fetch(`https://api.debugg.ai/api/v1/projects/${createdProjectUuid}/`, {
          method: 'DELETE', headers: { Authorization: `Token ${key}` },
        }).catch(() => {});
      }
    }
  },
};
