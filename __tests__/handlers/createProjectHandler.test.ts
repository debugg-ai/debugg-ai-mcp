/**
 * createProjectHandler unit tests — proof point for bead 9gh.
 *
 * Covers:
 *  - uuids-only path (backward compat; just forwards to service)
 *  - teamName resolution (exact match, case-insensitive)
 *  - repoName resolution (exact match)
 *  - mixed uuid + name (teamUuid + repoName)
 *  - NotFound when name has no backend match
 *  - AmbiguousMatch when multiple backend names match
 */

import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const mockInit = jest.fn<() => Promise<void>>();
const mockCreateProject = jest.fn<(...args: any[]) => Promise<any>>();
const mockListTeams = jest.fn<(...args: any[]) => Promise<any>>();
const mockListRepos = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../services/index.js', () => ({
  DebuggAIServerClient: jest.fn().mockImplementation(() => ({
    init: mockInit,
    createProject: mockCreateProject,
    listTeams: mockListTeams,
    listRepos: mockListRepos,
  })),
}));

let createProjectHandler: typeof import('../../handlers/createProjectHandler.js').createProjectHandler;

beforeAll(async () => {
  const mod = await import('../../handlers/createProjectHandler.js');
  createProjectHandler = mod.createProjectHandler;
});

const ctx: ToolContext = { requestId: 'test', timestamp: new Date() };

const TEAM_UUID = '11111111-1111-1111-1111-111111111111';
const REPO_UUID = '22222222-2222-2222-2222-222222222222';
const TEAM = { uuid: TEAM_UUID, name: 'Debugg AI', description: null };
const REPO = { uuid: REPO_UUID, name: 'debugg-ai/app', url: '', isGithubAuthorized: true };
const PROJECT = { uuid: 'p-uuid', name: 'Test', platform: 'web' };

describe('createProjectHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInit.mockResolvedValue(undefined);
  });

  describe('uuid mode (backward compat)', () => {
    test('teamUuid + repoUuid: forwards directly to service without lookups', async () => {
      mockCreateProject.mockResolvedValue(PROJECT);

      await createProjectHandler({
        name: 'Test', platform: 'web', teamUuid: TEAM_UUID, repoUuid: REPO_UUID,
      }, ctx);

      expect(mockListTeams).not.toHaveBeenCalled();
      expect(mockListRepos).not.toHaveBeenCalled();
      expect(mockCreateProject).toHaveBeenCalledWith({
        name: 'Test', platform: 'web', teamUuid: TEAM_UUID, repoUuid: REPO_UUID,
      });
    });
  });

  describe('name resolution', () => {
    test('teamName + repoName: both resolved via backend search, then createProject fired', async () => {
      mockListTeams.mockResolvedValue({ pageInfo: {}, teams: [TEAM] });
      mockListRepos.mockResolvedValue({ pageInfo: {}, repos: [REPO] });
      mockCreateProject.mockResolvedValue(PROJECT);

      await createProjectHandler({
        name: 'Test', platform: 'web', teamName: 'Debugg AI', repoName: 'debugg-ai/app',
      }, ctx);

      expect(mockListTeams).toHaveBeenCalled();
      expect(mockListRepos).toHaveBeenCalled();
      expect(mockCreateProject).toHaveBeenCalledWith({
        name: 'Test', platform: 'web', teamUuid: TEAM_UUID, repoUuid: REPO_UUID,
      });
    });

    test('teamName exact-match is case-insensitive', async () => {
      mockListTeams.mockResolvedValue({ pageInfo: {}, teams: [TEAM] }); // actual name: 'Debugg AI'
      mockCreateProject.mockResolvedValue(PROJECT);

      const res = await createProjectHandler({
        name: 'Test', platform: 'web', teamName: 'DEBUGG ai', repoUuid: REPO_UUID,
      }, ctx);

      expect(res.isError).not.toBe(true);
      expect(mockCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({ teamUuid: TEAM_UUID }),
      );
    });

    test('mixed: teamUuid + repoName resolves only repo', async () => {
      mockListRepos.mockResolvedValue({ pageInfo: {}, repos: [REPO] });
      mockCreateProject.mockResolvedValue(PROJECT);

      await createProjectHandler({
        name: 'Test', platform: 'web', teamUuid: TEAM_UUID, repoName: 'debugg-ai/app',
      }, ctx);

      expect(mockListTeams).not.toHaveBeenCalled();
      expect(mockListRepos).toHaveBeenCalled();
      expect(mockCreateProject).toHaveBeenCalledWith(
        expect.objectContaining({ teamUuid: TEAM_UUID, repoUuid: REPO_UUID }),
      );
    });
  });

  describe('error paths', () => {
    test('teamName has no backend match: isError:true NotFound', async () => {
      mockListTeams.mockResolvedValue({ pageInfo: {}, teams: [] });

      const res = await createProjectHandler({
        name: 'Test', platform: 'web', teamName: 'ghost', repoUuid: REPO_UUID,
      }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound|TeamNotFound/);
      expect(mockCreateProject).not.toHaveBeenCalled();
    });

    test('teamName has multiple exact matches: isError:true AmbiguousMatch with options', async () => {
      mockListTeams.mockResolvedValue({
        pageInfo: {},
        teams: [
          { uuid: 'a', name: 'Debugg AI' },
          { uuid: 'b', name: 'debugg ai' }, // case-insensitive equal
        ],
      });

      const res = await createProjectHandler({
        name: 'Test', platform: 'web', teamName: 'Debugg AI', repoUuid: REPO_UUID,
      }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/Ambiguous/);
      expect(body.candidates).toBeDefined();
      expect(body.candidates.length).toBeGreaterThanOrEqual(2);
      expect(mockCreateProject).not.toHaveBeenCalled();
    });

    test('repoName has no backend match: isError:true NotFound', async () => {
      mockListRepos.mockResolvedValue({ pageInfo: {}, repos: [] });

      const res = await createProjectHandler({
        name: 'Test', platform: 'web', teamUuid: TEAM_UUID, repoName: 'ghost/repo',
      }, ctx);

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text!);
      expect(body.error).toMatch(/NotFound|RepoNotFound/);
      expect(mockCreateProject).not.toHaveBeenCalled();
    });
  });
});
