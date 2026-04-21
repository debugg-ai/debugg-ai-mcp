/**
 * list_projects returns projects accessible to the API key, with optional
 * server-side search. Asserts shape + that search actually filters.
 */

export const flow = {
  name: 'list-projects',
  description: 'list_projects no-filter + search filter both return valid shape',
  async run({ client, step, assert, writeArtifact }) {
    let unfilteredCount = 0;

    await step('list_projects — no filter', async () => {
      const r = await client.request('tools/call', {
        name: 'list_projects',
        arguments: {},
      }, 30_000);
      await writeArtifact('no-filter.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter?.q === null, `Expected filter.q === null, got ${body.filter?.q}`);
      assert(typeof body.pageInfo?.totalCount === 'number', 'pageInfo.totalCount missing');
      assert(Array.isArray(body.projects), 'projects not an array');
      assert(body.pageInfo.totalCount >= 1, `Expected at least 1 project for this API key, got ${body.pageInfo.totalCount}`);
      for (const p of body.projects) {
        assert(typeof p.uuid === 'string', 'project.uuid missing');
        assert(typeof p.name === 'string', 'project.name missing');
        assert(typeof p.slug === 'string', 'project.slug missing');
        assert('repoName' in p, 'project.repoName missing (may be null)');
      }
      unfilteredCount = body.pageInfo.totalCount;
    });

    await step('list_projects — bogus search returns empty or smaller set', async () => {
      const bogus = 'zzz-nonexistent-repo-name-' + Math.random().toString(36).slice(2);
      const r = await client.request('tools/call', {
        name: 'list_projects',
        arguments: { q: bogus },
      }, 30_000);
      await writeArtifact('bogus-search.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter?.q === bogus, `Expected filter.q "${bogus}", got ${body.filter?.q}`);
      assert(Array.isArray(body.projects), 'projects not an array');
      assert(
        body.pageInfo.totalCount < unfilteredCount || body.pageInfo.totalCount === 0,
        `Search didn't filter: unfiltered=${unfilteredCount}, bogus=${body.pageInfo.totalCount}`
      );
    });

    await step('list_projects — known prefix returns at least one match', async () => {
      // Use a short slice of the first project's name as a server-side search term
      const first = JSON.parse(
        (await client.request('tools/call', { name: 'list_projects', arguments: {} }, 30_000))
          .content[0].text
      ).projects[0];
      const prefix = first.name.slice(0, Math.min(4, first.name.length));
      const r = await client.request('tools/call', {
        name: 'list_projects',
        arguments: { q: prefix },
      }, 30_000);
      await writeArtifact('prefix-search.json', r);
      assert(!r.isError, `Tool error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.totalCount >= 1, `Expected >=1 match for prefix "${prefix}", got ${body.pageInfo.totalCount}`);
    });
  },
};
