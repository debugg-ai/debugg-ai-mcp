/**
 * Project lifecycle: search → update → restore → delete-bogus.
 *
 * Scope: exercises search_projects (uuid mode) + update_project + delete-of-bogus-uuid only.
 * No destructive delete on a real project.
 *
 * Green definition:
 *   1. search_projects(filter) → pick target
 *   2. search_projects({uuid}) → returns projects:[{uuid,name,slug,...}] with curated detail shape
 *   3. Capture current description as "original"
 *   4. update_project({uuid, description: 'mcp-eval-<ts>'}) → {updated:true, project:{description matches}}
 *   5. search_projects({uuid}) → description reflects the patch
 *   6. update_project to restore original description
 *   7. delete_project({uuid: bogus}) → isError:true NotFound
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

    await step('setup: search_projects (filter mode) → pick target for probe', async () => {
      const r = await client.request('tools/call', { name: 'search_projects', arguments: {} }, 30_000);
      assert(!r.isError, `search_projects error: ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.pageInfo.totalCount >= 1, 'need at least 1 project for probe');
      // Prefer a non-main project if available; fall back to first
      const target = body.projects.find(p => p.name !== 'debugg-ai/debugg-ai-mcp') ?? body.projects[0];
      targetUuid = target.uuid;
      console.log(`  \x1b[2mprobe target: ${target.name} (${target.uuid})\x1b[0m`);
    });

    await step('search_projects (uuid mode) returns full project by uuid', async () => {
      const r = await client.request('tools/call', {
        name: 'search_projects',
        arguments: { uuid: targetUuid },
      }, 30_000);
      await writeArtifact('get.json', r);
      assert(!r.isError, `search_projects(uuid): ${r.content?.[0]?.text?.slice(0, 300)}`);
      const body = JSON.parse(r.content[0].text);
      assert(body.projects && body.projects.length === 1, 'uuid mode must return exactly one project');
      const project = body.projects[0];
      assert(project.uuid === targetUuid, `uuid mismatch: ${project.uuid}`);
      assert(typeof project.name === 'string', 'name missing');
      assert(typeof project.slug === 'string', 'slug missing');
      originalDescription = project.description ?? '';
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

      await step('search_projects (uuid mode) reflects the patched description', async () => {
        const r = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { uuid: targetUuid },
        }, 30_000);
        const body = JSON.parse(r.content[0].text);
        assert(body.projects[0].description === newDescription, `patch not persisted: ${body.projects[0].description}`);
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
