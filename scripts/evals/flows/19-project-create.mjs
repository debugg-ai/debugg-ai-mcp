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
 *
 * Bead v41 (resilience): the backend intermittently returns an HTML 500 page
 * instead of a structured error when a (team, repo) combination is rejected.
 * To keep this flow non-flaky, the create step iterates through up to 5
 * distinct repoName candidates and uses the first one that succeeds. If all
 * candidates return HTML-500-shaped responses, the step fails with a
 * diagnostic that points at this bead.
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

    let repoCandidates = [];

    try {
      await step('setup: discover a teamName (direct API) + repoName candidates (via search_projects)', async () => {
        teamName = await fetchTeamName();
        assert(teamName, 'No teams found via backend probe');

        // Pull up to 20 projects and extract DISTINCT repoNames — bead v41:
        // different repos have different backend tolerance for "create 2nd
        // project against me", so we need a list of candidates to iterate.
        const projectsResp = await client.request('tools/call', {
          name: 'search_projects',
          arguments: { pageSize: 20 },
        }, 30_000);
        const projects = JSON.parse(projectsResp.content[0].text).projects;
        const seen = new Set();
        for (const p of projects) {
          if (p.repoName && !seen.has(p.repoName)) {
            seen.add(p.repoName);
            repoCandidates.push(p.repoName);
          }
        }
        assert(repoCandidates.length > 0, 'No projects with a repoName found to probe');
      });

      await step('create_project via teamName + repoName — iterates repoCandidates to tolerate backend HTML-500 on (team,repo) conflict (bead v41)', async () => {
        const name = `mcp-eval-create-proj-${ts}`;
        const attempts = [];
        const MAX_ATTEMPTS = Math.min(5, repoCandidates.length);

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          const candidate = repoCandidates[i];
          const r = await client.request('tools/call', {
            name: 'create_project',
            arguments: { name, platform: 'web', teamName, repoName: candidate },
          }, 30_000);

          const firstText = r.content?.[0]?.text ?? '';
          attempts.push({
            repoName: candidate,
            isError: r.isError ?? false,
            firstBytes: firstText.slice(0, 240),
          });

          if (!r.isError) {
            // success — use this candidate for the rest of the flow
            await writeArtifact('create.json', r);
            await writeArtifact('create-attempts.json', { attempts, chosen: candidate });
            const body = JSON.parse(firstText);
            assert(body.created === true, 'response missing created:true');
            assert(body.project, 'response missing .project');
            assert(typeof body.project.uuid === 'string', 'project.uuid missing');
            assert(body.project.name === name, `name mismatch: ${body.project.name}`);
            assert(body.project.platform === 'web', `platform mismatch: ${body.project.platform}`);
            createdProjectUuid = body.project.uuid;
            repoName = candidate;
            return;
          }

          // Only retry on HTML-500-shaped backend flake (bead hd5). Any
          // structured error (e.g., TeamNotFound, validation) is a real bug —
          // fail fast, don't mask it.
          const looksLikeHtml500 = /DOCTYPE html|Server Error|Ooops!!!|<html/i.test(firstText);
          if (!looksLikeHtml500) {
            await writeArtifact('create-attempts.json', { attempts });
            throw new Error(
              `create_project failed with a non-retryable (structured) error on repo "${candidate}": ${firstText.slice(0, 400)}`,
            );
          }
          // else: loop and try the next candidate
        }

        await writeArtifact('create-attempts.json', { attempts });
        throw new Error(
          `All ${MAX_ATTEMPTS} repoName candidates returned HTML-500 errors from create_project. ` +
          `Either the backend is broadly unhealthy, or every repo in the account now rejects a second project ` +
          `(bead hd5 backend fix would make this diagnosable). Candidates tried: ${attempts.map(a => a.repoName).join(', ')}.`,
        );
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
