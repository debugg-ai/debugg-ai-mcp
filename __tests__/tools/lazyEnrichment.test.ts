/**
 * Bead 56kd.4: the tool surface enriches its description LAZILY on first use.
 *
 * At boot index.ts calls initTools(null) so no API call blocks startup. The
 * first getTools()/getTool() must kick off resolveProjectContext() and, once it
 * resolves a linked project, rebuild the tool definitions so the enriched
 * description (available environments + credential labels) is served next.
 */

import { jest } from '@jest/globals';
import type { ProjectContext } from '../../services/projectContext.js';

const mockResolve = jest.fn<() => Promise<ProjectContext | null>>();

jest.unstable_mockModule('../../services/projectContext.js', () => ({
  resolveProjectContext: mockResolve,
  getProjectContext: jest.fn(),
  mapEnvironments: jest.fn(),
  __resetProjectContextForTests: jest.fn(),
}));

let toolsMod: typeof import('../../tools/index.js');

const LINKED_CTX: ProjectContext = {
  repoName: 'org/repo',
  project: { uuid: 'p1', name: 'My App', slug: 'my-app' },
  environments: [
    {
      uuid: 'env-1',
      name: 'Production',
      url: 'https://app.test.com',
      isDefault: true,
      credentials: [{ label: 'Admin', username: 'admin@test.com' }],
    },
  ],
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  toolsMod = await import('../../tools/index.js');
});

describe('lazy tool-description enrichment (bead 56kd.4)', () => {
  it('base description is served before resolution completes', () => {
    mockResolve.mockReturnValue(new Promise(() => {})); // never resolves
    const tool = toolsMod.getTools().find((t) => t.name === 'check_app_in_browser')!;
    expect(tool.description).not.toContain('DETECTED PROJECT');
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('first getTools() triggers resolution; description enriches once it resolves', async () => {
    mockResolve.mockResolvedValue(LINKED_CTX);

    // First call returns base description synchronously and fires resolution.
    const before = toolsMod.getTools().find((t) => t.name === 'check_app_in_browser')!;
    expect(before.description).not.toContain('DETECTED PROJECT');

    await flush(); // let the fire-and-forget resolution + initTools(ctx) settle

    const after = toolsMod.getTools().find((t) => t.name === 'check_app_in_browser')!;
    expect(after.description).toContain('DETECTED PROJECT: "My App"');
    expect(after.description).toContain('Environment: "Production" (env-1) [default]');
    expect(after.description).toContain('"Admin" — user: admin@test.com');
  });

  it('resolution is triggered at most once across many getTools()/getTool() calls', async () => {
    mockResolve.mockResolvedValue(LINKED_CTX);

    toolsMod.getTools();
    toolsMod.getTool('check_app_in_browser');
    toolsMod.getTools();
    toolsMod.getTool('project');
    await flush();

    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('a null context (no linked project) leaves the base description intact', async () => {
    mockResolve.mockResolvedValue(null);

    toolsMod.getTools();
    await flush();

    const tool = toolsMod.getTools().find((t) => t.name === 'check_app_in_browser')!;
    expect(tool.description).not.toContain('DETECTED PROJECT');
  });

  it('a rejected resolution never throws and leaves the base description intact', async () => {
    mockResolve.mockRejectedValue(new Error('backend down'));

    expect(() => toolsMod.getTools()).not.toThrow();
    await flush();

    const tool = toolsMod.getTools().find((t) => t.name === 'check_app_in_browser')!;
    expect(tool.description).not.toContain('DETECTED PROJECT');
  });
});
