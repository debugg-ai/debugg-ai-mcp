import { DebuggAIServerClient } from '../services/index.js';

interface Named { uuid: string; name: string }
type ResolveResult = { uuid: string } | { error: string; message: string; candidates?: Named[] };

export async function resolveProject(
  client: DebuggAIServerClient,
  name: string,
): Promise<ResolveResult> {
  const { projects } = await client.listProjects({ page: 1, pageSize: 100 }, name);
  return resolveByName(name, projects, 'Project');
}

export async function resolveTestSuite(
  client: DebuggAIServerClient,
  suiteName: string,
  projectUuid: string,
): Promise<ResolveResult> {
  const { suites } = await client.listTestSuites({ projectUuid, search: suiteName });
  return resolveByName(suiteName, suites, 'TestSuite');
}

export function resolveByName(name: string, candidates: Named[], kind: string): ResolveResult {
  const needle = name.toLowerCase();
  const matches = candidates.filter(c => c.name.toLowerCase() === needle);
  if (matches.length === 0) {
    return {
      error: `${kind}NotFound`,
      message: `No ${kind.toLowerCase().replace('testsuite', 'test suite')} matching "${name}" found.` +
        (candidates.length > 0 ? ` Available: ${candidates.slice(0, 10).map(c => `"${c.name}"`).join(', ')}` : ' (none accessible to this API key)'),
    };
  }
  if (matches.length > 1) {
    return {
      error: 'AmbiguousMatch',
      message: `Multiple ${kind.toLowerCase().replace('testsuite', 'test suite')}s match "${name}". Pass the uuid directly.`,
      candidates: matches.map(m => ({ uuid: m.uuid, name: m.name })),
    };
  }
  return { uuid: matches[0].uuid };
}
