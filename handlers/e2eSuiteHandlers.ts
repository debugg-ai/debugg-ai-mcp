/**
 * E2E Suite Handlers
 * Handles E2E test suite creation, commit suite creation, and test status retrieval
 */

import { 
  ListTestsInput,
  ListTestSuitesInput,
  CreateTestSuiteInput,
  CreateCommitSuiteInput,
  ListCommitSuitesInput,
  GetTestStatusInput,
  ToolResponse, 
  ToolContext,
  ProgressCallback
} from '../types/index.js';
import { config } from '../config/index.js';
import { Logger } from '../utils/logger.js';
import { handleExternalServiceError } from '../utils/errors.js';
import { DebuggAIServerClient } from '../services/index.js';
import { readFileSync, existsSync } from 'fs';

const logger = new Logger({ module: 'e2eSuiteHandlers' });

/**
 * Handler for creating test suites
 */
export async function createTestSuiteHandler(
  input: CreateTestSuiteInput,
  context: ToolContext
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('create_test_suite', input);

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    // Merge input with config defaults
    const params = {
      repoName: input.repoName ?? config.defaults.repoName,
      branchName: input.branchName ?? config.defaults.branchName,
      repoPath: input.repoPath ?? config.defaults.repoPath,
      filePath: input.filePath ?? config.defaults.filePath,
    };

    if (!params.repoName || !params.repoPath) {
      throw new Error(
        'repoName and repoPath are required to generate tests. ' +
        'Pass them as tool arguments or set DEBUGGAI_LOCAL_REPO_NAME and DEBUGGAI_LOCAL_REPO_PATH.'
      );
    }

    logger.info('Creating E2E test suite', {
      description: input.description,
      ...params
    });

    // Create test suite
    const testSuite = await client.e2es.createE2eTestSuite(input.description, params);

    if (!testSuite) {
      throw new Error('Failed to create test suite - no response from service');
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      testSuite: {
        uuid: testSuite.uuid,
        id: testSuite.id,
        name: testSuite.name,
        description: testSuite.description,
        project: testSuite.project,
        key: testSuite.key,
        completed: testSuite.completed,
        completedAt: testSuite.completedAt,
        testsCount: testSuite.tests?.length || 0,
        feature: testSuite.feature,
        testType: testSuite.testType,
        timestamp: testSuite.timestamp,
        lastMod: testSuite.lastMod
      },
      context: {
        repoName: params.repoName,
        branchName: params.branchName,
        filePath: params.filePath
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Test suite created successfully', { 
      testSuiteUuid: testSuite.uuid,
      testsCount: testSuite.tests?.length || 0,
      duration: `${duration}ms`
    });

    logger.toolComplete('create_test_suite', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('create_test_suite', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'test suite creation');
  }
}

/**
 * Handler for creating commit suites
 */
export async function createCommitSuiteHandler(
  input: CreateCommitSuiteInput,
  context: ToolContext
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('create_commit_suite', input);

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    // Merge input with config defaults
    const params = {
      repoName: input.repoName ?? config.defaults.repoName,
      branchName: input.branchName ?? config.defaults.branchName,
      repoPath: input.repoPath ?? config.defaults.repoPath,
      filePath: input.filePath ?? config.defaults.filePath,
    };

    if (!params.repoName || !params.repoPath) {
      throw new Error(
        'repoName and repoPath are required to generate commit tests. ' +
        'Pass them as tool arguments or set DEBUGGAI_LOCAL_REPO_NAME and DEBUGGAI_LOCAL_REPO_PATH.'
      );
    }

    logger.info('Creating E2E commit suite', {
      description: input.description,
      ...params
    });

    // Create commit suite
    const commitSuite = await client.e2es.createE2eCommitSuite(input.description, params);

    if (!commitSuite) {
      throw new Error('Failed to create commit suite - no response from service');
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      commitSuite: {
        id: commitSuite.id,
        uuid: commitSuite.uuid,
        commitHash: commitSuite.commitHash,
        commitHashShort: commitSuite.commitHashShort,
        project: commitSuite.project,
        projectName: commitSuite.projectName,
        description: commitSuite.description,
        summarizedChanges: commitSuite.summarizedChanges,
        key: commitSuite.key,
        tunnelKey: commitSuite.tunnelKey,
        runStatus: commitSuite.runStatus,
        testsCount: commitSuite.tests?.length || 0,
        createdBy: commitSuite.createdBy,
        timestamp: commitSuite.timestamp,
        lastMod: commitSuite.lastMod
      },
      context: {
        repoName: params.repoName,
        branchName: params.branchName,
        filePath: params.filePath
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Commit suite created successfully', { 
      commitSuiteUuid: commitSuite.uuid,
      testsCount: commitSuite.tests?.length || 0,
      commitHash: commitSuite.commitHashShort,
      duration: `${duration}ms`
    });

    logger.toolComplete('create_commit_suite', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('create_commit_suite', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'commit suite creation');
  }
}

/**
 * Handler for getting test status
 */
export async function getTestStatusHandler(
  input: GetTestStatusInput,
  context: ToolContext
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('get_test_status', input);

  try {
    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    logger.info('Getting test status', { 
      suiteUuid: input.suiteUuid,
      suiteType: input.suiteType
    });

    let suiteData;
    let responseContent: any;

    if (input.suiteType === 'commit') {
      // Get commit suite status
      suiteData = await client.e2es.getE2eCommitSuite(input.suiteUuid);
      
      if (!suiteData) {
        throw new Error(`Commit suite not found: ${input.suiteUuid}`);
      }

      responseContent = {
        success: true,
        suiteType: 'commit',
        commitSuite: {
          id: suiteData.id,
          uuid: suiteData.uuid,
          commitHash: suiteData.commitHash,
          commitHashShort: suiteData.commitHashShort,
          project: suiteData.project,
          projectName: suiteData.projectName,
          description: suiteData.description,
          summarizedChanges: suiteData.summarizedChanges,
          runStatus: suiteData.runStatus,
          testsCount: suiteData.tests?.length || 0,
          tests: suiteData.tests?.map((test: any) => ({
            uuid: test.uuid,
            name: test.name,
            description: test.description,
            currentRun: test.curRun ? {
              uuid: test.curRun.uuid,
              status: test.curRun.status,
              outcome: test.curRun.outcome,
              runType: test.curRun.runType
            } : null
          })) || [],
          createdBy: suiteData.createdBy,
          timestamp: suiteData.timestamp,
          lastMod: suiteData.lastMod
        }
      };

    } else {
      // Get test suite status
      suiteData = await client.e2es.getE2eTestSuite(input.suiteUuid);
      
      if (!suiteData) {
        throw new Error(`Test suite not found: ${input.suiteUuid}`);
      }

      responseContent = {
        success: true,
        suiteType: 'test',
        testSuite: {
          uuid: suiteData.uuid,
          id: suiteData.id,
          name: suiteData.name,
          description: suiteData.description,
          project: suiteData.project,
          key: suiteData.key,
          completed: suiteData.completed,
          completedAt: suiteData.completedAt,
          testsCount: suiteData.tests?.length || 0,
          tests: suiteData.tests?.map((test: any) => ({
            uuid: test.uuid,
            name: test.name,
            description: test.description,
            currentRun: test.curRun ? {
              uuid: test.curRun.uuid,
              status: test.curRun.status,
              outcome: test.curRun.outcome,
              runType: test.curRun.runType
            } : null
          })) || [],
          feature: suiteData.feature,
          testType: suiteData.testType,
          timestamp: suiteData.timestamp,
          lastMod: suiteData.lastMod
        }
      };
    }

    const duration = Date.now() - startTime;
    responseContent.executionTime = `${duration}ms`;
    responseContent.timestamp = new Date().toISOString();

    logger.info('Test status retrieved successfully', { 
      suiteUuid: input.suiteUuid,
      suiteType: input.suiteType,
      testsCount: suiteData.tests?.length || 0,
      duration: `${duration}ms`
    });

    logger.toolComplete('get_test_status', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('get_test_status', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'test status retrieval');
  }
}

/**
 * Handler for listing E2E tests
 */
export async function listTestsHandler(
  input: ListTestsInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('list_tests', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Initializing client...' });
    }

    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Fetching tests...' });
    }

    // Merge input with config defaults
    const params = {
      ...input,
      repoName: input.repoName ?? config.defaults.repoName,
      branchName: input.branchName ?? config.defaults.branchName,
    };

    logger.info('Listing E2E tests', params);

    const testsList = await client.e2es.listE2eTests(params);

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Tests retrieved successfully' });
    }

    if (!testsList) {
      throw new Error('Failed to retrieve tests - no response from service');
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      tests: testsList.results.map((test: any) => ({
        uuid: test.uuid,
        name: test.name,
        description: test.description,
        currentRun: test.curRun ? {
          uuid: test.curRun.uuid,
          status: test.curRun.status,
          outcome: test.curRun.outcome,
          runType: test.curRun.runType
        } : null,
        timestamp: test.timestamp,
        lastMod: test.lastMod
      })),
      pagination: {
        total: testsList.count,
        page: input.page || 1,
        limit: input.limit || 20
      },
      filters: {
        repoName: params.repoName,
        branchName: params.branchName,
        status: input.status
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Tests listed successfully', { 
      testsCount: testsList.results.length,
      totalTests: testsList.count,
      duration: `${duration}ms`
    });

    logger.toolComplete('list_tests', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('list_tests', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'test listing');
  }
}

/**
 * Handler for listing E2E test suites
 */
export async function listTestSuitesHandler(
  input: ListTestSuitesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('list_test_suites', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Initializing client...' });
    }

    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Fetching test suites...' });
    }

    // Merge input with config defaults
    const params = {
      ...input,
      repoName: input.repoName ?? config.defaults.repoName,
      branchName: input.branchName ?? config.defaults.branchName,
    };

    logger.info('Listing E2E test suites', params);

    const suitesList = await client.e2es.listE2eTestSuites(params);

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Test suites retrieved successfully' });
    }

    if (!suitesList) {
      throw new Error('Failed to retrieve test suites - no response from service');
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      testSuites: suitesList.results.map((suite: any) => ({
        uuid: suite.uuid,
        id: suite.id,
        name: suite.name,
        description: suite.description,
        project: suite.project,
        key: suite.key,
        completed: suite.completed,
        completedAt: suite.completedAt,
        testsCount: suite.tests?.length || 0,
        feature: suite.feature,
        testType: suite.testType,
        timestamp: suite.timestamp,
        lastMod: suite.lastMod
      })),
      pagination: {
        total: suitesList.count,
        page: input.page || 1,
        limit: input.limit || 20
      },
      filters: {
        repoName: params.repoName,
        branchName: params.branchName,
        status: input.status
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Test suites listed successfully', { 
      suitesCount: suitesList.results.length,
      totalSuites: suitesList.count,
      duration: `${duration}ms`
    });

    logger.toolComplete('list_test_suites', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('list_test_suites', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'test suite listing');
  }
}

/**
 * Handler for listing E2E commit suites
 */
export async function listCommitSuitesHandler(
  input: ListCommitSuitesInput,
  context: ToolContext,
  progressCallback?: ProgressCallback
): Promise<ToolResponse> {
  const startTime = Date.now();
  logger.toolStart('list_commit_suites', input);

  try {
    if (progressCallback) {
      await progressCallback({ progress: 1, total: 3, message: 'Initializing client...' });
    }

    const client = new DebuggAIServerClient(config.api.key);
    await client.init();

    if (!client.e2es) {
      throw new Error('E2Es service not initialized');
    }

    if (progressCallback) {
      await progressCallback({ progress: 2, total: 3, message: 'Fetching commit suites...' });
    }

    // Merge input with config defaults
    const params = {
      ...input,
      repoName: input.repoName ?? config.defaults.repoName,
      branchName: input.branchName ?? config.defaults.branchName,
    };

    logger.info('Listing E2E commit suites', params);

    const suitesList = await client.e2es.listE2eCommitSuites(params);

    if (progressCallback) {
      await progressCallback({ progress: 3, total: 3, message: 'Commit suites retrieved successfully' });
    }

    if (!suitesList) {
      throw new Error('Failed to retrieve commit suites - no response from service');
    }

    const duration = Date.now() - startTime;
    
    const responseContent = {
      success: true,
      commitSuites: suitesList.results.map((suite: any) => ({
        id: suite.id,
        uuid: suite.uuid,
        commitHash: suite.commitHash,
        commitHashShort: suite.commitHashShort,
        project: suite.project,
        projectName: suite.projectName,
        description: suite.description,
        summarizedChanges: suite.summarizedChanges,
        key: suite.key,
        runStatus: suite.runStatus,
        testsCount: suite.tests?.length || 0,
        createdBy: suite.createdBy,
        timestamp: suite.timestamp,
        lastMod: suite.lastMod
      })),
      pagination: {
        total: suitesList.count,
        page: input.page || 1,
        limit: input.limit || 20
      },
      filters: {
        repoName: params.repoName,
        branchName: params.branchName,
        status: input.status
      },
      executionTime: `${duration}ms`,
      timestamp: new Date().toISOString()
    };

    logger.info('Commit suites listed successfully', { 
      suitesCount: suitesList.results.length,
      totalSuites: suitesList.count,
      duration: `${duration}ms`
    });

    logger.toolComplete('list_commit_suites', duration);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(responseContent, null, 2)
      }]
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.toolError('list_commit_suites', error as Error, duration);
    
    throw handleExternalServiceError(error, 'DebuggAI', 'commit suite listing');
  }
}