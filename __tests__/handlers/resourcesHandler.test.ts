/**
 * MCP resources (epic pglam): URI dispatch + read wrapping.
 * Reads must route each debugg-ai:// URI to the matching entity handler and
 * wrap its JSON payload as a resource content block.
 */

import { jest } from '@jest/globals';

const mockProject = jest.fn<(...a: any[]) => Promise<any>>();
const mockEnv = jest.fn<(...a: any[]) => Promise<any>>();
const mockExec = jest.fn<(...a: any[]) => Promise<any>>();

jest.unstable_mockModule('../../handlers/projectHandler.js', () => ({ projectHandler: mockProject }));
jest.unstable_mockModule('../../handlers/environmentHandler.js', () => ({ environmentHandler: mockEnv }));
jest.unstable_mockModule('../../handlers/executionsHandler.js', () => ({ executionsHandler: mockExec }));
jest.unstable_mockModule('../../config/index.js', () => ({ config: { api: { key: 'test-key' } } }));

const { readResource, RESOURCE_COLLECTIONS, RESOURCE_TEMPLATES } = await import('../../handlers/resourcesHandler.js');
const { config } = await import('../../config/index.js');

const textResult = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

beforeEach(() => {
  jest.clearAllMocks();
  (config as any).api.key = 'test-key';
  mockProject.mockResolvedValue(textResult({ projects: [{ uuid: 'p1' }] }));
  mockEnv.mockResolvedValue(textResult({ environments: [] }));
  mockExec.mockResolvedValue(textResult({ executions: [] }));
});

describe('resource catalog', () => {
  test('collections cover projects/environments/executions', () => {
    expect(RESOURCE_COLLECTIONS.map((r) => r.uri).sort()).toEqual([
      'debugg-ai://environments',
      'debugg-ai://executions',
      'debugg-ai://projects',
    ]);
    for (const r of RESOURCE_COLLECTIONS) expect(r.mimeType).toBe('application/json');
  });

  test('templates cover project/environment/execution items', () => {
    expect(RESOURCE_TEMPLATES.map((r) => r.uriTemplate).sort()).toEqual([
      'debugg-ai://environment/{uuid}',
      'debugg-ai://execution/{uuid}',
      'debugg-ai://project/{uuid}',
    ]);
  });
});

describe('readResource dispatch', () => {
  test('collection URI -> list action, wraps JSON payload', async () => {
    const out = await readResource('debugg-ai://projects');
    expect(mockProject).toHaveBeenCalledWith({ action: 'list' }, expect.any(Object));
    expect(out.contents[0]).toEqual({
      uri: 'debugg-ai://projects',
      mimeType: 'application/json',
      text: JSON.stringify({ projects: [{ uuid: 'p1' }] }),
    });
  });

  test('item URI -> get action with uuid', async () => {
    await readResource('debugg-ai://project/abc-123');
    expect(mockProject).toHaveBeenCalledWith({ action: 'get', uuid: 'abc-123' }, expect.any(Object));
  });

  test('routes environment + execution URIs to their handlers', async () => {
    await readResource('debugg-ai://environment/e1');
    expect(mockEnv).toHaveBeenCalledWith({ action: 'get', uuid: 'e1' }, expect.any(Object));
    await readResource('debugg-ai://executions');
    expect(mockExec).toHaveBeenCalledWith({ action: 'list' }, expect.any(Object));
  });

  test('unrecognized URI throws INVALID_PARAMS', async () => {
    await expect(readResource('debugg-ai://widgets/1')).rejects.toMatchObject({ code: -32602 });
    await expect(readResource('https://nope')).rejects.toMatchObject({ code: -32602 });
  });

  test('item URI without uuid throws', async () => {
    await expect(readResource('debugg-ai://project')).rejects.toMatchObject({ code: -32602 });
  });

  test('missing API key throws CONFIGURATION_ERROR (-32001)', async () => {
    (config as any).api.key = '';
    await expect(readResource('debugg-ai://projects')).rejects.toMatchObject({ code: -32001 });
    expect(mockProject).not.toHaveBeenCalled();
  });
});
