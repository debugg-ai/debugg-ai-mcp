/**
 * Action-tool dispatchers (epic yg7o6, C3).
 *
 * Mocks the per-verb handler bodies so we can assert (a) each `action` routes
 * to the right body and (b) delete actions are guarded by ensureConfirmed
 * before the underlying delete handler is ever called.
 */
import { jest } from '@jest/globals';
import { ToolContext } from '../../types/index.js';

const ok = (tag: string) => async () => ({ content: [{ type: 'text' as const, text: tag }] });

const mk = (name: string) => {
  const fn = jest.fn(ok(name));
  return { [name]: fn } as Record<string, any>;
};

const searchProjects = mk('searchProjectsHandler');
const createProject = mk('createProjectHandler');
const searchEnvironments = mk('searchEnvironmentsHandler');
const createEnvironment = mk('createEnvironmentHandler');
const updateEnvironment = mk('updateEnvironmentHandler');
const deleteEnvironment = mk('deleteEnvironmentHandler');
const searchTestSuites = mk('searchTestSuitesHandler');
const createTestSuite = mk('createTestSuiteHandler');
const runTestSuite = mk('runTestSuiteHandler');
const getTestSuiteResults = mk('getTestSuiteResultsHandler');
const deleteTestSuite = mk('deleteTestSuiteHandler');
const createTestCase = mk('createTestCaseHandler');
const updateTestCase = mk('updateTestCaseHandler');
const deleteTestCase = mk('deleteTestCaseHandler');
const searchExecutions = mk('searchExecutionsHandler');

jest.unstable_mockModule('../../handlers/searchProjectsHandler.js', () => searchProjects);
jest.unstable_mockModule('../../handlers/createProjectHandler.js', () => createProject);
jest.unstable_mockModule('../../handlers/searchEnvironmentsHandler.js', () => searchEnvironments);
jest.unstable_mockModule('../../handlers/createEnvironmentHandler.js', () => createEnvironment);
jest.unstable_mockModule('../../handlers/updateEnvironmentHandler.js', () => updateEnvironment);
jest.unstable_mockModule('../../handlers/deleteEnvironmentHandler.js', () => deleteEnvironment);
jest.unstable_mockModule('../../handlers/searchTestSuitesHandler.js', () => searchTestSuites);
jest.unstable_mockModule('../../handlers/createTestSuiteHandler.js', () => createTestSuite);
jest.unstable_mockModule('../../handlers/runTestSuiteHandler.js', () => runTestSuite);
jest.unstable_mockModule('../../handlers/getTestSuiteResultsHandler.js', () => getTestSuiteResults);
jest.unstable_mockModule('../../handlers/deleteTestSuiteHandler.js', () => deleteTestSuite);
jest.unstable_mockModule('../../handlers/createTestCaseHandler.js', () => createTestCase);
jest.unstable_mockModule('../../handlers/updateTestCaseHandler.js', () => updateTestCase);
jest.unstable_mockModule('../../handlers/deleteTestCaseHandler.js', () => deleteTestCase);
jest.unstable_mockModule('../../handlers/searchExecutionsHandler.js', () => searchExecutions);

let projectHandler: typeof import('../../handlers/projectHandler.js').projectHandler;
let environmentHandler: typeof import('../../handlers/environmentHandler.js').environmentHandler;
let testSuiteHandler: typeof import('../../handlers/testSuiteHandler.js').testSuiteHandler;
let testCaseHandler: typeof import('../../handlers/testCaseHandler.js').testCaseHandler;
let executionsHandler: typeof import('../../handlers/executionsHandler.js').executionsHandler;

beforeAll(async () => {
  projectHandler = (await import('../../handlers/projectHandler.js')).projectHandler;
  environmentHandler = (await import('../../handlers/environmentHandler.js')).environmentHandler;
  testSuiteHandler = (await import('../../handlers/testSuiteHandler.js')).testSuiteHandler;
  testCaseHandler = (await import('../../handlers/testCaseHandler.js')).testCaseHandler;
  executionsHandler = (await import('../../handlers/executionsHandler.js')).executionsHandler;
});

beforeEach(() => jest.clearAllMocks());

const ctx: ToolContext = { timestamp: new Date() };
const UUID = '00000000-0000-0000-0000-000000000001';

describe('routing', () => {
  test('project.get → searchProjectsHandler({uuid})', async () => {
    await projectHandler({ action: 'get', uuid: UUID } as any, ctx);
    expect(searchProjects.searchProjectsHandler).toHaveBeenCalledWith({ uuid: UUID }, ctx);
    expect(createProject.createProjectHandler).not.toHaveBeenCalled();
  });
  test('project.create → createProjectHandler (action stripped)', async () => {
    await projectHandler({ action: 'create', name: 'X', platform: 'web', teamName: 'T', repoName: 'o/r' } as any, ctx);
    const arg = createProject.createProjectHandler.mock.calls[0][0];
    expect(arg).not.toHaveProperty('action');
    expect(arg).toMatchObject({ name: 'X', platform: 'web' });
  });
  test('environment.update → updateEnvironmentHandler', async () => {
    await environmentHandler({ action: 'update', uuid: UUID, name: 'p' } as any, ctx);
    expect(updateEnvironment.updateEnvironmentHandler).toHaveBeenCalled();
  });
  test('test_suite.run/results route correctly', async () => {
    await testSuiteHandler({ action: 'run', suiteUuid: UUID } as any, ctx);
    await testSuiteHandler({ action: 'results', suiteUuid: UUID } as any, ctx);
    expect(runTestSuite.runTestSuiteHandler).toHaveBeenCalled();
    expect(getTestSuiteResults.getTestSuiteResultsHandler).toHaveBeenCalled();
  });
  test('executions.get/list → searchExecutionsHandler', async () => {
    await executionsHandler({ action: 'get', uuid: UUID } as any, ctx);
    await executionsHandler({ action: 'list', status: 'completed' } as any, ctx);
    expect(searchExecutions.searchExecutionsHandler).toHaveBeenCalledTimes(2);
  });
});

describe('delete guard (D2)', () => {
  test('environment.delete without confirm → refused, handler NOT called', async () => {
    const res = await environmentHandler({ action: 'delete', uuid: UUID } as any, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('confirmation_required');
    expect(deleteEnvironment.deleteEnvironmentHandler).not.toHaveBeenCalled();
  });
  test('environment.delete with confirm:true → handler called', async () => {
    await environmentHandler({ action: 'delete', uuid: UUID, confirm: true } as any, ctx);
    expect(deleteEnvironment.deleteEnvironmentHandler).toHaveBeenCalledWith({ uuid: UUID, projectUuid: undefined }, ctx);
  });
  test('test_suite.delete and test_case.delete are guarded', async () => {
    const r1 = await testSuiteHandler({ action: 'delete', suiteUuid: UUID } as any, ctx);
    const r2 = await testCaseHandler({ action: 'delete', testUuid: UUID } as any, ctx);
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    expect(deleteTestSuite.deleteTestSuiteHandler).not.toHaveBeenCalled();
    expect(deleteTestCase.deleteTestCaseHandler).not.toHaveBeenCalled();
  });
  test('test_case.delete with confirm → strips confirm, calls handler', async () => {
    await testCaseHandler({ action: 'delete', testUuid: UUID, confirm: true } as any, ctx);
    expect(deleteTestCase.deleteTestCaseHandler).toHaveBeenCalledWith({ testUuid: UUID }, ctx);
  });
});
