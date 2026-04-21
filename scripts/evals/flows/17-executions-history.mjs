/**
 * TDD red: list_executions, get_execution, cancel_execution don't exist yet.
 *
 * Green definition (exercises existing backend execution history — no new
 * executions created; no cleanup needed):
 *   1. list_executions (no filter) → {count >= 1, executions:[{uuid,status,workflow,...}]}
 *   2. get_execution({uuid}) on first listed uuid → {execution:{...full detail with nodeExecutions}}
 *   3. list_executions({status:'completed'}) → all returned have status === 'completed'
 *   4. cancel_execution on a completed uuid → isError:true with AlreadyCompleted (backend returns 409)
 *   5. cancel_execution on bogus uuid → isError:true + NotFound (backend 404)
 */

export const flow = {
  name: 'executions-history',
  description: 'TDD: list + get + cancel execution history (no new execs fired)',
  async run({ client, step, assert, writeArtifact }) {
    let anyCompletedUuid = null;

    await step('list_executions (no filter) returns paginated shape', async () => {
      const r = await client.request('tools/call', {
        name: 'list_executions',
        arguments: {},
      }, 30_000);
      await writeArtifact('list.json', r);
      assert(!r.isError, `list_executions: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(typeof body.pageInfo?.totalCount === 'number', 'pageInfo.totalCount missing');
      assert(Array.isArray(body.executions), 'executions not an array');
      assert(body.executions.length >= 1, `expected >=1 execution, got ${body.executions.length}`);
      for (const e of body.executions) {
        assert(typeof e.uuid === 'string', 'execution.uuid missing');
        assert(typeof e.status === 'string', 'execution.status missing');
      }
      // Find a completed one for later steps
      const completed = body.executions.find(e => e.status === 'completed');
      if (completed) anyCompletedUuid = completed.uuid;
    });

    await step('get_execution returns full detail including nodeExecutions', async () => {
      assert(anyCompletedUuid, 'setup: need a completed execution uuid');
      const r = await client.request('tools/call', {
        name: 'get_execution',
        arguments: { uuid: anyCompletedUuid },
      }, 30_000);
      await writeArtifact('get.json', r);
      assert(!r.isError, `get_execution: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.execution, 'response missing .execution');
      assert(body.execution.uuid === anyCompletedUuid, `uuid mismatch: ${body.execution.uuid}`);
      assert('nodeExecutions' in body.execution, 'execution.nodeExecutions missing');
      assert('state' in body.execution, 'execution.state missing');
    });

    await step('list_executions({status: completed}) filters server-side', async () => {
      const r = await client.request('tools/call', {
        name: 'list_executions',
        arguments: { status: 'completed' },
      }, 30_000);
      await writeArtifact('list-completed.json', r);
      assert(!r.isError, `list_executions filter: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.executions.every(e => e.status === 'completed'),
        `filter leaked non-completed: ${body.executions.filter(e => e.status !== 'completed').map(e => e.status).slice(0, 3)}`);
    });

    await step('cancel_execution on completed uuid returns AlreadyCompleted error', async () => {
      const r = await client.request('tools/call', {
        name: 'cancel_execution',
        arguments: { uuid: anyCompletedUuid },
      }, 30_000);
      await writeArtifact('cancel-completed.json', r);
      assert(r.isError === true, 'expected isError:true on cancelling completed exec');
      const body = JSON.parse(r.content[0].text);
      assert(
        /already|completed|cannot.?cancel/i.test((body.error ?? '') + ' ' + (body.message ?? '')),
        `expected AlreadyCompleted error, got: ${JSON.stringify(body).slice(0, 200)}`
      );
    });

    await step('cancel_execution on bogus uuid returns NotFound', async () => {
      const r = await client.request('tools/call', {
        name: 'cancel_execution',
        arguments: { uuid: '00000000-0000-0000-0000-000000000000' },
      }, 30_000);
      assert(r.isError === true, 'expected isError:true on bogus uuid');
      const body = JSON.parse(r.content[0].text);
      assert(
        /not.?found/i.test((body.error ?? '') + ' ' + (body.message ?? '')),
        `expected NotFound, got: ${JSON.stringify(body).slice(0, 200)}`
      );
    });

    await step('cancel_execution mid-flight transitions a running execution to cancelled', async () => {
      // Fire a real browser-agent run in the background. We don't await it immediately —
      // while it's running we'll find its uuid via list_executions and cancel it.
      const longPromise = client.request('tools/call', {
        name: 'check_app_in_browser',
        arguments: {
          url: 'https://example.com',
          description: 'Slowly inspect the page, read every heading and paragraph thoroughly before concluding.',
        },
      }, 240_000).catch(err => ({ __threw: true, err }));

      // Give the backend time to register the execution in the list. Under full-suite
      // load the backend can take 10-20s to transition a fresh exec to 'running'.
      let runningUuid = null;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !runningUuid) {
        await new Promise(r => setTimeout(r, 2000));
        // Query without a status filter so we catch execs that are still in pending/queued.
        const listResp = await client.request('tools/call', {
          name: 'list_executions',
          arguments: { pageSize: 5 },
        }, 30_000);
        const body = JSON.parse(listResp.content[0].text);
        const cancellable = body.executions.find(e => /running|pending|queued|in_progress/i.test(e.status));
        if (cancellable) runningUuid = cancellable.uuid;
      }
      assert(runningUuid, 'No cancellable execution appeared within 45s of firing check_app_in_browser');

      // Cancel it
      const cancelResp = await client.request('tools/call', {
        name: 'cancel_execution',
        arguments: { uuid: runningUuid },
      }, 30_000);
      await writeArtifact('cancel-running.json', cancelResp);
      assert(
        !cancelResp.isError,
        `cancel_execution on running uuid ${runningUuid} should succeed. Got: ${cancelResp.content?.[0]?.text?.slice(0, 400)}`
      );
      const cancelBody = JSON.parse(cancelResp.content[0].text);
      assert(cancelBody.cancelled === true, 'cancel response missing cancelled:true');
      assert(cancelBody.uuid === runningUuid, `cancel echoed wrong uuid: ${cancelBody.uuid}`);

      // Wait for the long-running call to unwind and verify state reflects cancellation.
      const longResult = await longPromise;
      assert(!longResult.__threw, `foregrounded check_app_in_browser threw: ${longResult.err?.message}`);
      await writeArtifact('cancelled-exec.json', longResult);

      // After cancellation, get_execution on the uuid should show cancelled status.
      const afterResp = await client.request('tools/call', {
        name: 'get_execution',
        arguments: { uuid: runningUuid },
      }, 30_000);
      const afterBody = JSON.parse(afterResp.content[0].text);
      const finalStatus = afterBody.execution.status;
      assert(
        /cancel/i.test(finalStatus),
        `expected cancelled status after cancel_execution, got "${finalStatus}"`
      );
    });
  },
};
