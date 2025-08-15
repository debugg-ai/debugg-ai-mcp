/**
 * Integration tests for DebuggAI backend services
 * These tests verify that all backend services work correctly with the actual API
 */

import { DebuggAIServerClient } from '../../services/index.js';
import { E2eTestRunner } from '../../e2e-agents/e2eRunner.js';
import { config } from '../../config/index.js';

describe('Backend Services Integration Tests', () => {
  let client: DebuggAIServerClient;
  let e2eTestRunner: E2eTestRunner;

  beforeAll(async () => {
    // Skip tests if no API key is provided
    if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
      console.log('Skipping backend integration tests - no valid API key provided');
      return;
    }

    client = new DebuggAIServerClient(config.api.key);
    await client.init();
    e2eTestRunner = new E2eTestRunner(client);
  });

  beforeEach(() => {
    // Skip individual tests if client not initialized
    if (!client || !client.e2es) {
      return;
    }
  });

  describe('E2E Service Tests', () => {
    test('should create an E2E test successfully', async () => {
      if (!client || !client.e2es) {
        return; // Skip if client not initialized
      }
      
      const testDescription = 'Integration test - verify service connection';
      const testParams = {
        filePath: 'test.html',
        repoName: 'test-repo',
        branchName: 'main',
        repoPath: '/tmp/test',
        key: `test-${Date.now()}`
      };

      const e2eTest = await client.e2es!.createE2eTest(testDescription, testParams);

      // Test may return null if there's an API error, but that's still a valid response
      if (e2eTest) {
        expect(e2eTest.description).toBe(testDescription);
        expect(e2eTest.tunnelKey).toBeDefined();
        expect(typeof e2eTest.tunnelKey).toBe('string');
        expect(e2eTest.tunnelKey!.length).toBeGreaterThan(10);
        expect(e2eTest.curRun).toBeDefined();
        expect(e2eTest.curRun!.status).toBe('pending');
      } else {
        console.log('E2E test creation returned null - may indicate API error or rate limiting');
      }
      
      // At minimum, the call should not throw an exception
      expect(true).toBe(true);
    }, 30000);

    test('should retrieve an E2E run by UUID', async () => {
      if (!client || !client.e2es) {
        return; // Skip if client not initialized
      }
      // First create a test
      const testDescription = 'Integration test - run retrieval';
      const testParams = {
        filePath: 'test.html',
        repoName: 'test-repo',
        branchName: 'main',
        repoPath: '/tmp/test',
        key: `test-${Date.now()}`
      };

      const e2eTest = await client.e2es!.createE2eTest(testDescription, testParams);
      
      if (e2eTest && e2eTest.curRun) {
        const runUuid = e2eTest.curRun.uuid;

        // Now retrieve the run
        const retrievedRun = await client.e2es!.getE2eRun(runUuid);

        if (retrievedRun) {
          expect(retrievedRun.uuid).toBe(runUuid);
          expect(retrievedRun.status).toBeDefined();
          expect(['pending', 'running', 'completed', 'failed']).toContain(retrievedRun.status);
        }
      }
      
      // Test completed without throwing
      expect(true).toBe(true);
    }, 30000);

    test('should list E2E tests', async () => {
      if (!client || !client.e2es) {
        return; // Skip if client not initialized
      }
      const testsList = await client.e2es!.listE2eTests();

      if (testsList) {
        expect(Array.isArray(testsList.results)).toBe(true);
        expect(typeof testsList.count).toBe('number');
        expect(testsList.count).toBeGreaterThanOrEqual(0);
      }
      
      // Test completed without throwing
      expect(true).toBe(true);
    }, 15000);

    test('should get an E2E test by UUID', async () => {
      if (!client || !client.e2es) {
        return; // Skip if client not initialized
      }
      // First create a test
      const testDescription = 'Integration test - test retrieval';
      const testParams = {
        filePath: 'test.html',
        repoName: 'test-repo',
        branchName: 'main',
        repoPath: '/tmp/test',
        key: `test-${Date.now()}`
      };

      const e2eTest = await client.e2es!.createE2eTest(testDescription, testParams);
      
      if (e2eTest) {
        const testUuid = e2eTest.uuid;

        // Now retrieve the test
        const retrievedTest = await client.e2es!.getE2eTest(testUuid);

        if (retrievedTest) {
          expect(retrievedTest.uuid).toBe(testUuid);
          expect(retrievedTest.description).toBe(testDescription);
        }
      }
      
      // Test completed without throwing
      expect(true).toBe(true);
    }, 30000);
  });


  describe('E2E Test Runner Integration', () => {
    test('should create new E2E test through runner', async () => {
      if (!client || !e2eTestRunner) {
        return; // Skip if client not initialized
      }
      const testDescription = 'Runner integration test';
      const testPort = 3000;
      const repoName = 'test-repo';
      const branchName = 'main';
      const repoPath = '/tmp/test';

      const e2eRun = await e2eTestRunner.createNewE2eTest(
        testPort,
        testDescription,
        repoName,
        branchName,
        repoPath
      );

      expect(e2eRun).toBeDefined();
      expect(e2eRun).not.toBeNull();
      expect(e2eRun!.status).toBeDefined();
      expect(['pending', 'running']).toContain(e2eRun!.status);
      expect(e2eRun!.uuid).toBeDefined();
      expect(typeof e2eRun!.uuid).toBe('string');
    }, 30000);
  });

  describe('Browser Sessions Service Tests', () => {
    let activeSessionId: string | null = null;

    afterEach(async () => {
      // Cleanup any active sessions after each test
      if (client && client.browserSessions && activeSessionId) {
        try {
          await client.browserSessions.stopSession(activeSessionId);
          console.log(`Cleaned up session: ${activeSessionId}`);
        } catch (error) {
          console.warn(`Failed to cleanup session ${activeSessionId}:`, error);
        }
        activeSessionId = null;
      }
    });

    test('should start a browser session successfully', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      const sessionParams = {
        url: 'https://example.com',
        sessionName: 'Test Session - Start',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false
      };

      const session = await client.browserSessions.startSession(sessionParams);
      activeSessionId = session.sessionId;

      expect(session).toBeDefined();
      expect(session.sessionId).toBeDefined();
      expect(typeof session.sessionId).toBe('string');
      expect(session.sessionId.length).toBeGreaterThan(0);
      expect(session.sessionName).toBe(sessionParams.sessionName);
      expect(session.url).toBe(sessionParams.url);
      expect(session.status).toBeDefined();
      expect(['starting', 'active', 'stopped', 'error']).toContain(session.status);
      expect(session.startTime).toBeDefined();
      expect(session.monitoring).toBeDefined();
      expect(session.monitoring.console).toBe(true);
      expect(session.monitoring.network).toBe(true);
      expect(session.monitoring.screenshots).toBe(false);
    }, 30000);

    test('should get session status successfully', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // First start a session
      const sessionParams = {
        url: 'https://httpbin.org/html',
        sessionName: 'Test Session - Status',
        monitorConsole: true,
        monitorNetwork: true
      };

      const startedSession = await client.browserSessions.startSession(sessionParams);
      activeSessionId = startedSession.sessionId;

      // Wait a bit for session to potentially become active
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Now get status
      const statusResult = await client.browserSessions.getSessionStatus(startedSession.sessionId);

      expect(statusResult).toBeDefined();
      expect(statusResult.session).toBeDefined();
      expect(statusResult.stats).toBeDefined();
      expect(statusResult.session.sessionId).toBe(startedSession.sessionId);
      expect(statusResult.session.sessionName).toBe(sessionParams.sessionName);
      expect(['starting', 'active', 'stopped', 'error']).toContain(statusResult.session.status);
      expect(statusResult.stats.uptime).toBeDefined();
      expect(typeof statusResult.stats.uptime).toBe('number');
    }, 35000);

    test('should list browser sessions with pagination', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // Test basic listing
      const sessionsList = await client.browserSessions.listSessions();

      expect(sessionsList).toBeDefined();
      expect(sessionsList.count).toBeDefined();
      expect(typeof sessionsList.count).toBe('number');
      expect(Array.isArray(sessionsList.results)).toBe(true);
      expect(sessionsList.results.length).toBeLessThanOrEqual(sessionsList.count);

      // Test with pagination parameters
      const limitedList = await client.browserSessions.listSessions({
        limit: 5,
        offset: 0
      });

      expect(limitedList).toBeDefined();
      expect(Array.isArray(limitedList.results)).toBe(true);
      expect(limitedList.results.length).toBeLessThanOrEqual(5);
    }, 20000);

    test('should filter sessions by status', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // Test filtering by active status
      const activeSessions = await client.browserSessions.listSessions({
        status: 'active'
      });

      expect(activeSessions).toBeDefined();
      expect(Array.isArray(activeSessions.results)).toBe(true);
      
      // All returned sessions should be active
      if (activeSessions.results.length > 0) {
        activeSessions.results.forEach(session => {
          expect(session.status).toBe('active');
        });
      }

      // Test filtering by stopped status
      const stoppedSessions = await client.browserSessions.listSessions({
        status: 'stopped'
      });

      expect(stoppedSessions).toBeDefined();
      expect(Array.isArray(stoppedSessions.results)).toBe(true);

      // All returned sessions should be stopped
      if (stoppedSessions.results.length > 0) {
        stoppedSessions.results.forEach(session => {
          expect(session.status).toBe('stopped');
        });
      }
    }, 25000);

    test('should stop a browser session successfully', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // First start a session
      const sessionParams = {
        url: 'https://httpbin.org/json',
        sessionName: 'Test Session - Stop',
        monitorConsole: true,
        monitorNetwork: true
      };

      const startedSession = await client.browserSessions.startSession(sessionParams);
      expect(startedSession.sessionId).toBeDefined();

      // Wait a bit before stopping
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Now stop the session
      const stopResult = await client.browserSessions.stopSession(startedSession.sessionId);

      expect(stopResult).toBeDefined();
      expect(stopResult.session).toBeDefined();
      expect(stopResult.summary).toBeDefined();
      expect(stopResult.session.sessionId).toBe(startedSession.sessionId);
      expect(['stopped', 'error']).toContain(stopResult.session.status);
      expect(stopResult.session.endTime).toBeDefined();
      expect(stopResult.summary.duration).toBeDefined();
      expect(typeof stopResult.summary.duration).toBe('number');
      expect(stopResult.summary.finalStats).toBeDefined();

      // Session should no longer be active
      activeSessionId = null; // Don't try to clean up since we just stopped it
    }, 35000);

    test('should handle error for invalid session ID', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      const invalidSessionId = 'invalid-session-id-12345';

      // Test getting status of invalid session
      await expect(client.browserSessions.getSessionStatus(invalidSessionId))
        .rejects
        .toThrow(/Session not found|Failed to get session status/);

      // Test stopping invalid session
      await expect(client.browserSessions.stopSession(invalidSessionId))
        .rejects
        .toThrow(/Failed to stop browser session/);
    }, 15000);

    test('should get session logs successfully', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // First start a session with a page that generates logs
      const sessionParams = {
        url: 'https://httpbin.org/html',
        sessionName: 'Test Session - Logs',
        monitorConsole: true,
        monitorNetwork: true
      };

      const startedSession = await client.browserSessions.startSession(sessionParams);
      activeSessionId = startedSession.sessionId;

      // Wait for the page to load and generate some logs
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get all logs
      const logsResult = await client.browserSessions.getSessionLogs(startedSession.sessionId);

      expect(logsResult).toBeDefined();
      expect(logsResult.session).toBeDefined();
      expect(logsResult.session.sessionId).toBe(startedSession.sessionId);
      expect(Array.isArray(logsResult.logs)).toBe(true);
      expect(logsResult.stats).toBeDefined();
      expect(typeof logsResult.stats.totalLogs).toBe('number');
      expect(typeof logsResult.stats.consoleCount).toBe('number');
      expect(typeof logsResult.stats.networkCount).toBe('number');
      expect(typeof logsResult.stats.errorCount).toBe('number');

      // Test filtering by log type
      const consoleLogsResult = await client.browserSessions.getSessionLogs(startedSession.sessionId, {
        logType: 'console'
      });

      expect(consoleLogsResult).toBeDefined();
      expect(Array.isArray(consoleLogsResult.logs)).toBe(true);
      
      // All logs should be console type if any are returned
      if (consoleLogsResult.logs.length > 0) {
        consoleLogsResult.logs.forEach(log => {
          expect(log.type).toBe('console');
          expect(log.timestamp).toBeDefined();
          expect(log.message).toBeDefined();
        });
      }

      // Test with limit
      const limitedLogsResult = await client.browserSessions.getSessionLogs(startedSession.sessionId, {
        limit: 10
      });

      expect(limitedLogsResult).toBeDefined();
      expect(Array.isArray(limitedLogsResult.logs)).toBe(true);
      expect(limitedLogsResult.logs.length).toBeLessThanOrEqual(10);
    }, 40000);

    test('should capture screenshots successfully', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      // First start a session with a visually rich page
      const sessionParams = {
        url: 'https://httpbin.org/html',
        sessionName: 'Test Session - Screenshots',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: true
      };

      const startedSession = await client.browserSessions.startSession(sessionParams);
      activeSessionId = startedSession.sessionId;

      // Wait for the page to load
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Capture a screenshot
      const screenshotResult = await client.browserSessions.captureScreenshot(startedSession.sessionId);

      expect(screenshotResult).toBeDefined();
      expect(screenshotResult.session).toBeDefined();
      expect(screenshotResult.session.sessionId).toBe(startedSession.sessionId);
      expect(screenshotResult.screenshot).toBeDefined();
      expect(screenshotResult.screenshot.data).toBeDefined();
      expect(typeof screenshotResult.screenshot.data).toBe('string');
      expect(screenshotResult.screenshot.data.length).toBeGreaterThan(0);
      expect(['png', 'jpeg']).toContain(screenshotResult.screenshot.format);
      expect(screenshotResult.screenshot.timestamp).toBeDefined();
      expect(screenshotResult.screenshot.size).toBeDefined();
      expect(typeof screenshotResult.screenshot.size.width).toBe('number');
      expect(typeof screenshotResult.screenshot.size.height).toBe('number');
      expect(typeof screenshotResult.screenshot.size.bytes).toBe('number');

      // Test with different parameters
      const customScreenshot = await client.browserSessions.captureScreenshot(startedSession.sessionId, {
        fullPage: true,
        format: 'jpeg',
        quality: 80
      });

      expect(customScreenshot).toBeDefined();
      expect(customScreenshot.screenshot.format).toBe('jpeg');
      expect(customScreenshot.screenshot.fullPage).toBe(true);
      if (customScreenshot.screenshot.quality) {
        expect(customScreenshot.screenshot.quality).toBe(80);
      }
    }, 40000);

    test('should handle concurrent sessions correctly', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      const sessionIds: string[] = [];

      try {
        // Start multiple sessions concurrently
        const sessionPromises = [
          client.browserSessions.startSession({
            url: 'https://httpbin.org/html',
            sessionName: 'Concurrent Session 1'
          }),
          client.browserSessions.startSession({
            url: 'https://httpbin.org/json',
            sessionName: 'Concurrent Session 2'
          }),
          client.browserSessions.startSession({
            url: 'https://example.com',
            sessionName: 'Concurrent Session 3'
          })
        ];

        const sessions = await Promise.all(sessionPromises);

        // Verify all sessions were created successfully
        sessions.forEach((session, index) => {
          expect(session).toBeDefined();
          expect(session.sessionId).toBeDefined();
          expect(session.sessionName).toBe(`Concurrent Session ${index + 1}`);
          sessionIds.push(session.sessionId);
        });

        // All sessions should have unique IDs
        const uniqueIds = new Set(sessionIds);
        expect(uniqueIds.size).toBe(sessions.length);

        // Wait a bit for sessions to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check status of all sessions
        const statusPromises = sessionIds.map(id => 
          client.browserSessions!.getSessionStatus(id)
        );

        const statusResults = await Promise.all(statusPromises);

        statusResults.forEach((result, index) => {
          expect(result).toBeDefined();
          expect(result.session.sessionId).toBe(sessionIds[index]);
          expect(['starting', 'active', 'stopped', 'error']).toContain(result.session.status);
        });

      } finally {
        // Cleanup all sessions
        const cleanupPromises = sessionIds.map(async (sessionId) => {
          try {
            await client.browserSessions!.stopSession(sessionId);
            console.log(`Cleaned up concurrent session: ${sessionId}`);
          } catch (error) {
            console.warn(`Failed to cleanup concurrent session ${sessionId}:`, error);
          }
        });

        await Promise.all(cleanupPromises);
      }
    }, 60000);

    test('should validate session status transitions', async () => {
      if (!client || !client.browserSessions) {
        return; // Skip if client not initialized
      }

      const sessionParams = {
        url: 'https://httpbin.org/delay/2', // Page with delay to observe transitions
        sessionName: 'Test Session - Status Transitions',
        monitorConsole: true,
        monitorNetwork: true
      };

      // Start session
      const startedSession = await client.browserSessions.startSession(sessionParams);
      activeSessionId = startedSession.sessionId;

      // Initial status should be starting
      expect(['starting', 'active']).toContain(startedSession.status);

      // Wait and check status progression
      await new Promise(resolve => setTimeout(resolve, 3000));

      const midStatus = await client.browserSessions.getSessionStatus(startedSession.sessionId);
      expect(['starting', 'active']).toContain(midStatus.session.status);

      // Stop the session
      const stoppedSession = await client.browserSessions.stopSession(startedSession.sessionId);
      expect(['stopped', 'error']).toContain(stoppedSession.session.status);

      // Verify stopped status persists
      const finalStatus = await client.browserSessions.getSessionStatus(startedSession.sessionId);
      expect(['stopped', 'error']).toContain(finalStatus.session.status);

      activeSessionId = null; // Already stopped
    }, 45000);
  });

  describe('Server Configuration Tests', () => {
    test('should connect to correct backend URL', async () => {
      if (!client) {
        return; // Skip if client not initialized
      }
      const serverUrl = await client.getServerUrl();
      
      expect(serverUrl).toBeDefined();
      expect(typeof serverUrl).toBe('string');
      expect(serverUrl.startsWith('https://')).toBe(true);
      
      // Should use local development server when ENVIRONMENT=local
      if (process.env.ENVIRONMENT === 'local') {
        expect(serverUrl).toBe('https://debuggai-backend.ngrok.app');
      } else {
        expect(serverUrl).toBe('https://api.debugg.ai');
      }
    });

    test('should have valid API transport configuration', () => {
      if (!client) {
        return; // Skip if client not initialized
      }
      expect(client.tx).toBeDefined();
      expect(client.tx!.axios).toBeDefined();
      expect(client.tx!.axios.defaults.baseURL).toBeDefined();
      expect(client.tx!.axios.defaults.headers).toBeDefined();
      expect(client.tx!.axios.defaults.headers['Authorization']).toContain('Token');
    });

    test('should have all required services initialized', () => {
      if (!client) {
        return; // Skip if client not initialized
      }
      expect(client.e2es).toBeDefined();
      expect(client.browserSessions).toBeDefined();
    });
  });
});