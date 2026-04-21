/**
 * TDD red: get_project, update_project, delete_project don't exist yet.
 *
 * Scope: this lifecycle exercises get + update + delete-of-bogus-uuid only.
 * We do NOT perform a destructive delete on a real project from eval — too risky
 * in a CI-repeating context. create_project is tracked separately (see bead qb4).
 *
 * Green definition:
 *   1. list_projects → pick the first project (target for probes)
 *   2. get_project({uuid}) → returns {project:{uuid,name,slug,...}}
 *   3. Capture current description as "original"
 *   4. update_project({uuid, description: 'mcp-eval-<ts>'}) → {updated:true, project:{description matches}}
 *   5. get_project → description reflects the patch
 *   6. update_project to restore original description (idempotent patch)
 *   7. get_project → description restored
 *   8. delete_project({uuid: bogus}) → isError:true + NotFound (proves the code path; does NOT destroy anything)
 */

export const flow = {
  name: 'project-crud-lifecycle',
  tags: ['fast', 'crud', 'project'],
  description: 'TDD: get/update/delete project; delete tested only against bogus uuid to avoid destruction',
  async run({ client, step, assert, writeArtifact }) {
    const ts = Date.now();
    const newDescription = `mcp-eval-project-crud-${ts}`;
    let targetUuid = null;
    let originalDescription = '';

    await step('setup: list_projects → pick target for probe', async () => {
      const r = await client.request('tools/call', { name: 'list_projects', arguments: {} }, 30_000);
      assert(!r.isError, `list_projects error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.totalCount >= 1, 'need at least 1 project for probe');
      // Prefer a non-main project if available; fall back to first
      const target = body.projects.find(p => p.name !== 'debugg-ai/debugg-ai-mcp') ?? body.projects[0];
      targetUuid = target.uuid;
      console.log(`  \x1b[2mprobe target: ${target.name} (${target.uuid})\x1b[0m`);
    });

    await step('get_project returns full project by uuid', async () => {
      const r = await client.request('tools/call', {
        name: 'get_project',
        arguments: { uuid: targetUuid },
      }, 30_000);
      await writeArtifact('get.json', r);
      assert(!r.isError, `get_project: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.project, 'response missing .project');
      assert(body.project.uuid === targetUuid, `uuid mismatch: ${body.project.uuid}`);
      assert(typeof body.project.name === 'string', 'name missing');
      assert(typeof body.project.slug === 'string', 'slug missing');
      originalDescription = body.project.description ?? '';
    });

    try {
      await step('update_project patches description', async () => {
        const r = await client.request('tools/call', {
          name: 'update_project',
          arguments: { uuid: targetUuid, description: newDescription },
        }, 30_000);
        await writeArtifact('update.json', r);
        assert(!r.isError, `update_project: ${r.content?.[0]?.text?.slice(0, 300)}`);
        const body = JSON.parse(r.content[0].text);
        assert(body.updated === true, 'missing updated:true');
        assert(body.project.uuid === targetUuid, 'uuid not echoed');
        assert(body.project.description === newDescription, `description not updated: ${body.project.description}`);
      });

      await step('get_project reflects the patched description', async () => {
        const r = await client.request('tools/call', {
          name: 'get_project',
          arguments: { uuid: targetUuid },
        }, 30_000);
        const body = JSON.parse(r.content[0].text);
        assert(body.project.description === newDescription, `patch not persisted: ${body.project.description}`);
      });
    } finally {
      // Always restore the original description — eval must not leave mutations on a real project
      try {
        const r = await client.request('tools/call', {
          name: 'update_project',
          arguments: { uuid: targetUuid, description: originalDescription },
        }, 30_000);
        if (!r.isError) {
          console.log(`  \x1b[2mrestored description on ${targetUuid}\x1b[0m`);
        } else {
          console.log(`  \x1b[33mWARN\x1b[0m restore failed (project description left as "${newDescription}")`);
        }
      } catch (e) {
        console.log(`  \x1b[33mWARN\x1b[0m restore threw: ${e.message}`);
      }
    }

    await step('delete_project with bogus uuid returns NotFound (isError:true)', async () => {
      const r = await client.request('tools/call', {
        name: 'delete_project',
        arguments: { uuid: '00000000-0000-0000-0000-000000000000' },
      }, 30_000);
      await writeArtifact('delete-bogus.json', r);
      assert(r.isError === true, 'expected isError:true on bogus uuid');
      const body = JSON.parse(r.content[0].text);
      assert(
        /not.?found/i.test((body.error ?? '') + ' ' + (body.message ?? '')),
        `expected NotFound, got: ${JSON.stringify(body).slice(0, 200)}`
      );
    });
  },
};
