/**
 * list_environments returns a structured response describing environments
 * for a project. Default = current git repo; projectUuid overrides;
 * q filters via backend search.
 */

export const flow = {
  name: 'list-environments',
  description: 'list_environments default + q filter + projectUuid override',
  async run({ client, step, assert, writeArtifact }) {
    await step('list_environments — default (no inputs)', async () => {
      const r = await client.request('tools/call', {
        name: 'list_environments',
        arguments: {},
      }, 30_000);
      await writeArtifact('default.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert('environments' in body, 'Response missing "environments" field');
      assert(Array.isArray(body.environments), '"environments" is not an array');
      assert(body.filter?.q === null, `Expected filter.q === null, got ${body.filter?.q}`);
      assert(typeof body.pageInfo?.totalCount === 'number', 'pageInfo.totalCount missing');
      for (const e of body.environments) {
        assert(typeof e.uuid === 'string', 'environment.uuid missing');
        assert(typeof e.name === 'string', 'environment.name missing');
        assert(typeof e.isActive === 'boolean', 'environment.isActive missing');
      }
    });

    await step('list_environments — q that matches an existing env name returns it', async () => {
      // First, pull the default env list to get a real name
      const all = await client.request('tools/call', {
        name: 'list_environments',
        arguments: {},
      }, 30_000);
      const allBody = JSON.parse(all.content[0].text);
      if (allBody.count === 0) {
        console.log('  \x1b[2m(no envs to match against, skipping)\x1b[0m');
        return;
      }
      const needle = allBody.environments[0].name.slice(0, Math.min(5, allBody.environments[0].name.length));
      const r = await client.request('tools/call', {
        name: 'list_environments',
        arguments: { q: needle },
      }, 30_000);
      await writeArtifact('matching-q.json', r);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.totalCount >= 1, `q="${needle}" should match at least one env, got ${body.pageInfo.totalCount}`);
      assert(body.environments.every(e => e.name.toLowerCase().includes(needle.toLowerCase())),
        'q filter returned non-matching envs');
    });

    await step('list_environments — bogus q returns empty or smaller set', async () => {
      const bogus = 'zzz-nonexistent-env-' + Math.random().toString(36).slice(2);
      const r = await client.request('tools/call', {
        name: 'list_environments',
        arguments: { q: bogus },
      }, 30_000);
      await writeArtifact('bogus-search.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter?.q === bogus, `Expected filter.q "${bogus}", got ${body.filter?.q}`);
      assert(body.pageInfo.totalCount === 0, `Expected 0 matches for bogus q, got ${body.pageInfo.totalCount}`);
    });

    await step('list_environments — projectUuid override', async () => {
      // First grab a project UUID via list_projects
      const projectsResp = await client.request('tools/call', {
        name: 'list_projects',
        arguments: {},
      }, 30_000);
      const projects = JSON.parse(projectsResp.content[0].text).projects;
      assert(projects.length >= 1, 'Need at least 1 project for override test');
      const targetProjectUuid = projects[0].uuid;

      const r = await client.request('tools/call', {
        name: 'list_environments',
        arguments: { projectUuid: targetProjectUuid },
      }, 30_000);
      await writeArtifact('project-override.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.project.uuid === targetProjectUuid, 'project.uuid did not echo the override');
    });
  },
};
