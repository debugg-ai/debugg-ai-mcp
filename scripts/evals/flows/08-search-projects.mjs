/**
 * search_projects end-to-end against the real backend.
 *
 * Proves:
 *  - uuid mode: single-row with FULL project detail; uuid-miss → isError:true NotFound
 *  - filter mode: pagination + q filter; uuid NOT present in response
 *  - shape uniformity: {filter, pageInfo, projects[]} in both modes
 *
 * Replaces the prior 08-list-projects.mjs flow (which only covered list mode).
 */

export const flow = {
  name: 'search-projects',
  tags: ['fast', 'project'],
  description: 'search_projects end-to-end: uuid mode + filter mode + NotFound path',
  async run({ client, step, assert, writeArtifact }) {
    let firstUuid = null;
    let firstName = null;

    await step('filter mode (no input): returns paginated projects with summary shape', async () => {
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: {},
      });
      await writeArtifact('filter-empty.json', r);
      assert(!r.isError, `unexpected error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter && 'q' in body.filter, `filter missing q: ${JSON.stringify(body.filter)}`);
      assert(body.pageInfo && typeof body.pageInfo.totalCount === 'number', 'pageInfo shape wrong');
      assert(Array.isArray(body.projects), 'projects must be an array');
      assert(body.projects.length > 0, 'filter mode with no q should return some projects');
      firstUuid = body.projects[0].uuid;
      firstName = body.projects[0].name;
      // Summary shape: must have uuid/name/slug/repoName only (or subset)
      assert(body.projects[0].uuid, 'summary missing uuid');
      assert(body.projects[0].name, 'summary missing name');
    });

    await step('uuid mode: returns single-row with FULL project detail', async () => {
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { uuid: firstUuid },
      });
      await writeArtifact('uuid-hit.json', r);
      assert(!r.isError, `uuid hit errored: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter.uuid === firstUuid, `filter.uuid should echo input; got ${JSON.stringify(body.filter)}`);
      assert(body.pageInfo.totalCount === 1, `uuid mode totalCount should be 1, got ${body.pageInfo.totalCount}`);
      assert(body.pageInfo.hasMore === false, `uuid mode should never have more`);
      assert(body.projects.length === 1, `uuid mode must return exactly 1 project, got ${body.projects.length}`);
      assert(body.projects[0].uuid === firstUuid, `returned project uuid must match`);
      // Curated detail shape (11 keys, not the raw ~38 from the backend):
      // uuid, name, slug, platform, repoName, description, status, language, framework, timestamp, lastMod
      const p = body.projects[0];
      const expectedKeys = ['slug', 'platform', 'repoName', 'description', 'status', 'language', 'framework', 'timestamp', 'lastMod'];
      for (const k of expectedKeys) {
        assert(k in p, `uuid-mode project missing expected key "${k}"`);
      }
    });

    await step('uuid mode miss: NotFound with isError:true', async () => {
      const bogus = '00000000-0000-0000-0000-000000000000';
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { uuid: bogus },
      });
      await writeArtifact('uuid-miss.json', r);
      assert(r.isError === true, `expected isError:true for bogus uuid`);
      const body = JSON.parse(r.content[0].text);
      assert(body.error === 'NotFound', `expected error='NotFound', got ${body.error}`);
      assert(body.uuid === bogus, `echoed uuid should match input`);
    });

    await step('filter mode with q: narrows results, paginated shape intact', async () => {
      // Use the name fragment of the first known project — must yield at least 1 match
      const q = firstName.split(/\s|\//)[0];
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { q, page: 1, pageSize: 5 },
      });
      await writeArtifact('filter-q.json', r);
      assert(!r.isError, `filter errored: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.filter.q === q, `filter.q should echo; got ${body.filter.q}`);
      assert(body.pageInfo.pageSize === 5, `pageSize should echo; got ${body.pageInfo.pageSize}`);
      assert(body.projects.length <= 5, `pageSize must cap result count`);
    });

    await step('pagination clamps: pageSize > 200 → clamp to 200', async () => {
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { pageSize: 500 },
      });
      assert(!r.isError);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.pageSize <= 200,
        `pageSize must be clamped to <= 200; got ${body.pageInfo.pageSize}`);
    });
  },
};
