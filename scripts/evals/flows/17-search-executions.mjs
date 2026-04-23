/**
 * search_executions end-to-end — replaces 17-executions-history.mjs.
 *
 * Exercises:
 *   - Filter mode (no args) returns paginated summaries
 *   - uuid mode returns single execution with full detail (nodeExecutions + state)
 *   - status filter server-side
 *   - projectUuid scope filter (locks bead j5z invariant)
 *   - bogus projectUuid returns totalCount:0 (not silently ignored)
 *
 * Does NOT test cancel_execution — that tool was removed in bead 49b (it was
 * redundant; backend spin-down happens automatically on terminal status).
 * Does NOT fire new browser runs — reads existing history only, no real cost.
 */

export const flow = {
  name: 'search-executions',
  tags: ['fast', 'exec'],
  description: 'search_executions: list + get-by-uuid + status filter + projectUuid scope',
  async run({ client, step, assert, writeArtifact }) {
    let anyCompletedUuid = null;

    await step('filter mode (no input): returns paginated summaries', async () => {
      const r = await client.request('tools/call', {
        name: 'search_executions',
        arguments: {},
      }, 30_000);
      await writeArtifact('list.json', r);
      assert(!r.isError, `search_executions: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(typeof body.pageInfo?.totalCount === 'number', 'pageInfo.totalCount missing');
      assert(Array.isArray(body.executions), 'executions not an array');
      assert(body.executions.length >= 1, `expected >=1 execution, got ${body.executions.length}`);
      for (const e of body.executions) {
        assert(typeof e.uuid === 'string', 'execution.uuid missing');
        assert(typeof e.status === 'string', 'execution.status missing');
      }
      const completed = body.executions.find(e => e.status === 'completed');
      if (completed) anyCompletedUuid = completed.uuid;
    });

    await step('uuid mode: returns full detail with nodeExecutions + state', async () => {
      assert(anyCompletedUuid, 'setup: need a completed execution uuid');
      const r = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { uuid: anyCompletedUuid },
      }, 30_000);
      await writeArtifact('get.json', r);
      assert(!r.isError, `uuid mode: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.totalCount === 1, 'uuid mode totalCount must be 1');
      assert(body.executions.length === 1, 'uuid mode must return exactly 1 execution');
      const exec = body.executions[0];
      assert(exec.uuid === anyCompletedUuid, `uuid mismatch: ${exec.uuid}`);
      assert('nodeExecutions' in exec, 'execution.nodeExecutions missing in uuid mode');
      assert('state' in exec, 'execution.state missing in uuid mode');
    });

    await step('uuid miss: isError:true NotFound', async () => {
      const r = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { uuid: '00000000-0000-0000-0000-000000000000' },
      }, 30_000);
      assert(r.isError === true, 'expected isError:true on bogus uuid');
      const body = JSON.parse(r.content[0].text);
      assert(body.error === 'NotFound', `expected NotFound, got ${body.error}`);
    });

    await step('status filter: all returned execs have status === completed', async () => {
      const r = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { status: 'completed' },
      }, 30_000);
      await writeArtifact('list-completed.json', r);
      assert(!r.isError, `status filter: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.executions.every(e => e.status === 'completed'),
        `filter leaked non-completed: ${body.executions.filter(e => e.status !== 'completed').map(e => e.status).slice(0, 3)}`);
    });

    await step('projectUuid scope + bogus-uuid returns totalCount:0 (locks j5z)', async () => {
      const projects = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { pageSize: 1 },
      }, 30_000);
      const targetProjectUuid = JSON.parse(projects.content[0].text).projects[0].uuid;

      const unfiltered = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { pageSize: 1 },
      }, 30_000);
      const unfilteredCount = JSON.parse(unfiltered.content[0].text).pageInfo.totalCount;

      const scoped = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { projectUuid: targetProjectUuid, pageSize: 1 },
      }, 30_000);
      await writeArtifact('list-by-project.json', scoped);
      const scopedBody = JSON.parse(scoped.content[0].text);
      assert(scopedBody.filter.projectUuid === targetProjectUuid, 'filter.projectUuid not echoed');
      assert(scopedBody.pageInfo.totalCount <= unfilteredCount,
        `scoped ${scopedBody.pageInfo.totalCount} > unfiltered ${unfilteredCount}`);

      const bogus = await client.request('tools/call', {
        name: 'search_executions',
        arguments: { projectUuid: '00000000-0000-0000-0000-000000000000', pageSize: 1 },
      }, 30_000);
      const bogusBody = JSON.parse(bogus.content[0].text);
      assert(bogusBody.pageInfo.totalCount === 0,
        `bogus projectUuid expected totalCount=0, got ${bogusBody.pageInfo.totalCount} — j5z regressed`);
    });
  },
};
