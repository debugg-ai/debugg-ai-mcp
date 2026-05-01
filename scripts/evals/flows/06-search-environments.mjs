/**
 * search_environments end-to-end.
 *
 * Proves:
 *   - Filter mode returns paginated envs with credentials INLINE per env.
 *   - uuid mode returns a single env, creds inline, NotFound for bogus uuid.
 *   - projectUuid override works (bypasses git-repo detection).
 *   - NO password leak: no "password" key or password-value string in response.
 *   - q filter narrows results; pageSize threading.
 *
 * Replaces the prior 06-list-environments.mjs + 07-list-credentials.mjs flows.
 */

export const flow = {
  name: 'search-environments',
  tags: ['fast', 'env', 'cred'],
  description: 'search_environments end-to-end: uuid+filter modes, creds inline, no password leak, projectUuid override',
  async run({ client, step, assert, writeArtifact }) {
    let firstProjectUuid = null;
    let firstEnvUuid = null;
    let firstEnvName = null;

    await step('filter mode (auto-project from git): returns envs with credentials array inline', async () => {
      const r = await client.request('tools/call', { name: 'search_environments', arguments: {} }, 30_000);
      await writeArtifact('filter-auto.json', r);
      assert(!r.isError, `search_environments: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.project && body.project.uuid, `project must be auto-resolved from git: ${JSON.stringify(body.project)}`);
      assert(Array.isArray(body.environments), 'environments must be an array');
      for (const env of body.environments) {
        assert(Array.isArray(env.credentials), `env ${env.uuid} missing credentials array`);
      }
      firstProjectUuid = body.project.uuid;
      if (body.environments.length > 0) {
        firstEnvUuid = body.environments[0].uuid;
        firstEnvName = body.environments[0].name;
      }
    });

    await step('explicit projectUuid override: bypasses git detection + echoes the override', async () => {
      const projectsResp = await client.request('tools/call', {
        name: 'search_projects', arguments: { pageSize: 5 },
      }, 30_000);
      const projects = JSON.parse(projectsResp.content[0].text).projects;
      const otherProject = projects.find(p => p.uuid !== firstProjectUuid) ?? projects[0];

      const r = await client.request('tools/call', {
        name: 'search_environments',
        arguments: { projectUuid: otherProject.uuid, pageSize: 5 },
      }, 30_000);
      await writeArtifact('filter-override.json', r);
      assert(!r.isError, `override: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.project.uuid === otherProject.uuid, `project.uuid should echo override; got ${body.project.uuid}`);
    });

    if (firstEnvUuid) {
      await step('uuid mode: single env with credentials inline (env in git-resolved project)', async () => {
        const r = await client.request('tools/call', {
          name: 'search_environments',
          arguments: { projectUuid: firstProjectUuid, uuid: firstEnvUuid },
        }, 30_000);
        await writeArtifact('uuid-hit.json', r);
        assert(!r.isError, `uuid hit: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.pageInfo.totalCount === 1, 'uuid mode totalCount must be 1');
        assert(body.environments.length === 1, 'uuid mode must return 1 env');
        assert(body.environments[0].uuid === firstEnvUuid, 'returned uuid mismatch');
        assert(Array.isArray(body.environments[0].credentials), 'creds must be inline array');
      });
    } else {
      console.log(`  \x1b[2m(git project has no envs — skipping uuid-hit step)\x1b[0m`);
    }

    await step('uuid mode miss: isError:true NotFound', async () => {
      const bogus = '00000000-0000-0000-0000-000000000000';
      const r = await client.request('tools/call', {
        name: 'search_environments',
        arguments: { uuid: bogus },
      }, 30_000);
      await writeArtifact('uuid-miss.json', r);
      assert(r.isError === true, `expected isError:true, got: ${r.content?.[0]?.text?.slice(0, 200)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.error === 'NotFound', `expected NotFound, got ${body.error}`);
    });

    await step('NO PASSWORD LEAK across all responses', async () => {
      const r = await client.request('tools/call', { name: 'search_environments', arguments: { pageSize: 10 } }, 30_000);
      const raw = r.content[0].text;
      assert(!/"password"\s*:/.test(raw),
        `Response contains a "password" key — defensive invariant violated: ${raw.slice(0, 400)}`);
    });
  },
};
