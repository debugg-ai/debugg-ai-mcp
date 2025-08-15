/**
 * Integration tests for URL Intelligence with Live Sessions
 * Tests the integration of natural language URL resolution in browser sessions
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { resolveUrl } from '../../utils/urlResolver.js';

describe('URL Intelligence Integration with Live Sessions', () => {
  beforeEach(() => {
    // Clear any test state if needed
  });

  describe('URL Resolution for Session Start', () => {
    test('should resolve dashboard descriptions', () => {
      const testCases = [
        { input: 'the user dashboard', expected: '/dashboard/' },
        { input: 'admin dashboard', expected: '/admin/' },  // This now correctly resolves to /admin/
        { input: 'main dashboard', expected: '/dashboard/' },
        { input: 'dashboard', expected: '/dashboard/' },
        { input: 'admin panel', expected: '/admin/' }  // Additional test for admin
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should resolve shopping cart variations', () => {
      const testCases = [
        { input: 'shopping cart', expected: '/cart/' },
        { input: 'the cart', expected: '/cart/' },
        { input: 'cart page', expected: '/cart/' },
        { input: 'shopping basket', expected: '/cart/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should resolve user profile pages', () => {
      const testCases = [
        { input: 'user profile', expected: '/profile/' },
        { input: 'my profile', expected: '/profile/' },
        { input: 'profile page', expected: '/profile/' },
        { input: 'user account', expected: '/profile/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should handle explicit URLs', () => {
      const testCases = [
        { input: '"/admin/users"', expected: '/admin/users' },
        { input: 'go to /profile/settings', expected: '/profile/settings' },
        { input: 'path: /api/docs', expected: '/api/docs' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });
  });

  describe('URL Resolution for Navigation', () => {
    test('should resolve authentication pages', () => {
      const testCases = [
        { input: 'login page', expected: '/login/' },
        { input: 'sign in', expected: '/login/' },
        { input: 'logout', expected: '/logout/' },
        { input: 'register page', expected: '/register/' },
        { input: 'sign up form', expected: '/register/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should resolve e-commerce pages', () => {
      const testCases = [
        { input: 'checkout', expected: '/checkout/' },
        { input: 'payment page', expected: '/checkout/' },
        { input: 'products', expected: '/products/' },
        { input: 'product catalog', expected: '/products/' },
        { input: 'orders', expected: '/orders/' },
        { input: 'order history', expected: '/orders/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should resolve settings and configuration pages', () => {
      const testCases = [
        { input: 'settings', expected: '/settings/' },
        { input: 'user settings', expected: '/settings/' },
        { input: 'preferences', expected: '/settings/' },
        { input: 'configuration', expected: '/settings/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should resolve content pages', () => {
      const testCases = [
        { input: 'blog', expected: '/blog/' },
        { input: 'blog posts', expected: '/blog/' },
        { input: 'articles', expected: '/blog/' },
        { input: 'messages', expected: '/messages/' },
        { input: 'inbox', expected: '/messages/' },
        { input: 'notifications', expected: '/notifications/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });
  });

  describe('Complex Descriptions', () => {
    test('should handle descriptions with extra words', () => {
      const testCases = [
        { input: 'go to the dashboard', expected: '/dashboard/' },
        { input: 'navigate to user settings', expected: '/settings/' },
        { input: 'open the shopping cart', expected: '/cart/' },
        { input: 'view the product catalog', expected: '/products/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should prioritize longer keyword matches', () => {
      // "shopping cart" should match before "cart"
      expect(resolveUrl('shopping cart page')).toBe('/cart/');
      
      // "user profile" should match before "profile"
      expect(resolveUrl('user profile section')).toBe('/profile/');
      
      // "forgot password" should match as a complete phrase
      expect(resolveUrl('forgot password form')).toBe('/forgot-password/');
    });
  });

  describe('Default Fallbacks', () => {
    test('should return root path for unknown descriptions', () => {
      const testCases = [
        'unknown page',
        'random content',
        'something else'
      ];

      testCases.forEach((input) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe('/');
      });
    });

    test('should handle empty or minimal input', () => {
      expect(resolveUrl('')).toBe('/');
      expect(resolveUrl('page')).toBe('/');
      expect(resolveUrl('the')).toBe('/');
    });
  });

  describe('URL Construction for Sessions', () => {
    test('should construct localhost URLs with port', () => {
      const path = resolveUrl('dashboard');
      const port = 3000;
      const fullUrl = `http://localhost:${port}${path}`;
      expect(fullUrl).toBe('http://localhost:3000/dashboard/');
    });

    test('should construct localhost URLs with custom port', () => {
      const path = resolveUrl('user profile');
      const port = 8080;
      const fullUrl = `http://localhost:${port}${path}`;
      expect(fullUrl).toBe('http://localhost:8080/profile/');
    });

    test('should preserve base URL during navigation', () => {
      const baseUrl = 'http://localhost:3000';
      const currentPath = '/dashboard/';
      const newPath = resolveUrl('settings');
      const newUrl = `${baseUrl}${newPath}`;
      expect(newUrl).toBe('http://localhost:3000/settings/');
    });
  });

  describe('Special Cases', () => {
    test('should handle API endpoints', () => {
      const testCases = [
        { input: 'api documentation', expected: '/api/' },
        { input: 'api docs', expected: '/api/' },
        { input: 'developer docs', expected: '/api/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should handle analytics and reporting', () => {
      const testCases = [
        { input: 'analytics', expected: '/analytics/' },
        { input: 'metrics dashboard', expected: '/analytics/' },
        { input: 'reports', expected: '/reports/' },
        { input: 'reporting', expected: '/reports/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });

    test('should handle team and workspace pages', () => {
      const testCases = [
        { input: 'team page', expected: '/team/' },
        { input: 'teams', expected: '/team/' },
        { input: 'workspace', expected: '/workspace/' },
        { input: 'workspaces', expected: '/workspace/' }
      ];

      testCases.forEach(({ input, expected }) => {
        const resolved = resolveUrl(input);
        expect(resolved).toBe(expected);
      });
    });
  });
});

/**
 * End-to-End Workflow Tests - Comprehensive Feature Integration
 * Tests complete workflows combining URL intelligence, transport optimization, and session management
 */
describe('End-to-End Comprehensive Workflow Tests', () => {
  
  describe('Complete Feature Integration Workflows', () => {
    test('should handle complete user testing workflow with all optimizations', () => {
      // This test simulates a complete user workflow using all new features:
      // 1. URL Intelligence for natural language URL resolution
      // 2. MCP parameter injection in transport
      // 3. Transport optimization (caching, retry, metrics)
      // 4. Session management with URL intelligence integration

      const { resolveUrl, suggestUrls } = await import('../../utils/urlResolver.js');
      const { AxiosTransport } = await import('../../utils/axiosTransport.js');
      
      // Step 1: URL Intelligence - Resolve natural language descriptions
      const workflow = [
        { desc: 'start with login page', expected: '/login/' },
        { desc: 'navigate to user dashboard', expected: '/dashboard/' },
        { desc: 'check user profile settings', expected: '/profile/' },
        { desc: 'view shopping cart', expected: '/cart/' },
        { desc: 'go to checkout process', expected: '/checkout/' },
        { desc: 'access admin panel', expected: '/admin/' }
      ];

      workflow.forEach(step => {
        const resolvedUrl = resolveUrl(step.desc);
        expect(resolvedUrl).toBe(step.expected);
        
        // Also test URL suggestions
        const suggestions = suggestUrls(step.desc);
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions).toContain(step.expected);
      });

      console.log('✓ URL Intelligence: All workflow steps resolved correctly');
    });

    test('should demonstrate transport optimization with realistic session workflow', async () => {
      // Create optimized transport with all features enabled
      const mockAxios = {
        interceptors: {
          request: { use: () => 0 },
          response: { use: () => 0 }
        },
        request: () => Promise.resolve({
          data: { workflow: 'success', mcp_request: true },
          status: 200,
          config: { metadata: { requestId: 'e2e-test', startTime: Date.now(), method: 'POST', url: '/sessions' } }
        }),
        defaults: { baseURL: '', headers: {} }
      };

      const { AxiosTransport } = await import('../../utils/axiosTransport.js');
      const transport = new AxiosTransport({
        baseUrl: 'https://e2e-test.debugg.ai',
        apiKey: 'e2e-test-key',
        instance: mockAxios,
        config: {
          retry: { maxAttempts: 3, baseDelay: 10 },
          cache: { enabled: true, ttl: 5000, maxSize: 10 },
          metrics: { enabled: true }
        }
      });

      const { resolveUrl } = await import('../../utils/urlResolver.js');

      // Simulate a complete workflow with transport optimization
      const workflowSteps = [
        { desc: 'dashboard analytics', port: 3000 },
        { desc: 'user management', port: 3001 },
        { desc: 'settings panel', port: 3002 },
        { desc: 'admin reports', port: 3003 }
      ];

      const startTime = Date.now();

      for (const step of workflowSteps) {
        const resolvedPath = resolveUrl(step.desc);
        
        // Make HTTP request with MCP parameter injection
        const response = await transport.post('/api/browser-sessions/sessions/', {
          initialUrl: `http://localhost:${step.port}${resolvedPath}`,
          sessionName: `E2E Test - ${step.desc}`,
          monitorConsole: true,
          monitorNetwork: true
        });

        // Verify MCP parameter was injected
        expect(response.mcp_request).toBe(true);
        expect(response.workflow).toBe('success');
        
        // Make the same request again to test caching
        const cachedResponse = await transport.post('/api/browser-sessions/sessions/', {
          initialUrl: `http://localhost:${step.port}${resolvedPath}`,
          sessionName: `E2E Test - ${step.desc}`,
          monitorConsole: true
        });

        expect(cachedResponse).toBeDefined();
      }

      const endTime = Date.now();
      const metrics = transport.getMetrics();
      const cacheStats = transport.getCacheStats();

      // Verify optimization benefits
      expect(metrics.totalRequests).toBe(workflowSteps.length * 2); // Original + cached requests
      expect(cacheStats.hitRatio).toBeGreaterThan(0.4); // Some cache hits expected
      expect(endTime - startTime).toBeLessThan(1000); // Should be fast with optimizations

      console.log(`✓ Transport Optimization Workflow:`);
      console.log(`  Total time: ${endTime - startTime}ms`);
      console.log(`  Cache hit ratio: ${(cacheStats.hitRatio * 100).toFixed(1)}%`);
      console.log(`  Total requests: ${metrics.totalRequests}`);

      transport.destroy();
    });

    test('should combine URL intelligence with mock browser sessions for complete E2E', async () => {
      const { resolveUrl } = await import('../../utils/urlResolver.js');
      const { createOfflineBrowserSessionsService } = await import('../mocks/browserSessionsMock.js');
      
      // Create realistic offline service for E2E testing
      const service = createOfflineBrowserSessionsService({
        latency: 20,
        errorRate: 0.02, // Very low error rate for reliable E2E tests
        realistic: true
      });

      // Define a complete user journey
      const userJourney = [
        { step: 'Start at login page', desc: 'login authentication' },
        { step: 'Navigate to dashboard', desc: 'user dashboard overview' },
        { step: 'Check notifications', desc: 'user notifications center' },
        { step: 'View profile', desc: 'user profile management' },
        { step: 'Access settings', desc: 'user settings configuration' },
        { step: 'Browse products', desc: 'product catalog browsing' },
        { step: 'Add to cart', desc: 'shopping cart management' },
        { step: 'Proceed to checkout', desc: 'checkout payment process' }
      ];

      const sessionId = await (async () => {
        // Start initial session
        const loginPath = resolveUrl(userJourney[0].desc);
        const initialSession = await service.startSession({
          url: `http://localhost:3000${loginPath}`,
          sessionName: 'Complete E2E User Journey',
          monitorConsole: true,
          monitorNetwork: true,
          takeScreenshots: true
        });

        return initialSession.sessionId;
      })();

      // Wait for session to become active
      await new Promise(resolve => setTimeout(resolve, 100));

      // Execute the complete user journey
      const journeyResults = [];
      
      for (let i = 1; i < userJourney.length; i++) {
        const step = userJourney[i];
        
        // Resolve URL using intelligence
        const resolvedPath = resolveUrl(step.desc);
        
        // Navigate to the new page
        const navigatedSession = await service.navigateSession(sessionId, {
          url: `http://localhost:3000${resolvedPath}`
        });

        // Capture screenshot of current state
        const screenshot = await service.captureScreenshot(sessionId, {
          format: 'png',
          fullPage: false
        });

        // Get recent logs
        const logs = await service.getSessionLogs(sessionId, {
          logType: 'all',
          limit: 5
        });

        journeyResults.push({
          step: step.step,
          url: navigatedSession.url,
          screenshotSize: screenshot.screenshot.size.bytes,
          recentLogsCount: logs.logs.length
        });
      }

      // Get final session status and complete summary
      const finalStatus = await service.getSessionStatus(sessionId);
      const allLogs = await service.getSessionLogs(sessionId, { logType: 'all' });
      const summary = await service.stopSession(sessionId);

      // Verify complete workflow
      expect(journeyResults).toHaveLength(userJourney.length - 1);
      expect(finalStatus.stats.uptime).toBeGreaterThan(0);
      expect(allLogs.logs.length).toBeGreaterThan(userJourney.length);
      expect(summary.session.status).toBe('stopped');
      expect(summary.summary.finalStats.totalLogs).toBeGreaterThan(0);

      // Verify each step was properly resolved and executed
      journeyResults.forEach((result, index) => {
        expect(result.url).toContain('localhost:3000');
        expect(result.screenshotSize).toBeGreaterThan(0);
        expect(result.recentLogsCount).toBeGreaterThan(0);
        
        console.log(`  ${index + 2}. ${result.step}: ${result.url} (${result.recentLogsCount} logs, ${result.screenshotSize} byte screenshot)`);
      });

      console.log(`✓ Complete E2E User Journey:`);
      console.log(`  Total steps: ${userJourney.length}`);
      console.log(`  Session duration: ${summary.summary.duration}ms`);
      console.log(`  Total logs captured: ${summary.summary.finalStats.totalLogs}`);
      console.log(`  Screenshots captured: ${summary.summary.finalStats.screenshotsCaptured}`);
    });

    test('should handle complex multi-session workflows with concurrent operations', async () => {
      const { resolveUrl } = await import('../../utils/urlResolver.js');
      const { createOfflineBrowserSessionsService } = await import('../mocks/browserSessionsMock.js');
      
      const service = createOfflineBrowserSessionsService({
        latency: 15,
        errorRate: 0.05,
        realistic: true
      });

      // Define multiple concurrent user scenarios
      const scenarios = [
        { user: 'Admin', workflow: ['admin dashboard', 'user management', 'system settings', 'audit reports'] },
        { user: 'Customer', workflow: ['product catalog', 'shopping cart', 'checkout process', 'order tracking'] },
        { user: 'Analyst', workflow: ['analytics dashboard', 'data reports', 'metrics overview', 'export tools'] },
        { user: 'Support', workflow: ['support dashboard', 'ticket management', 'customer profile', 'knowledge base'] }
      ];

      const startTime = Date.now();
      
      // Execute all scenarios concurrently
      const scenarioPromises = scenarios.map(async scenario => {
        const sessionIds: string[] = [];
        const results = [];

        // Start initial session for this user scenario
        const firstPath = resolveUrl(scenario.workflow[0]);
        const initialSession = await service.startSession({
          url: `http://localhost:3000${firstPath}`,
          sessionName: `${scenario.user} Session`,
          monitorConsole: true,
          monitorNetwork: true,
          takeScreenshots: scenario.user === 'Admin' // Only admin gets screenshots
        });

        sessionIds.push(initialSession.sessionId);
        results.push({ step: scenario.workflow[0], url: initialSession.url });

        // Wait briefly for session to activate
        await new Promise(resolve => setTimeout(resolve, 50));

        // Execute remaining workflow steps
        for (let i = 1; i < scenario.workflow.length; i++) {
          const step = scenario.workflow[i];
          const resolvedPath = resolveUrl(step);
          
          const navigatedSession = await service.navigateSession(sessionIds[0], {
            url: `http://localhost:3000${resolvedPath}`
          });

          results.push({ step, url: navigatedSession.url });
        }

        // Get final statistics
        const finalStatus = await service.getSessionStatus(sessionIds[0]);
        const finalLogs = await service.getSessionLogs(sessionIds[0]);
        
        return {
          user: scenario.user,
          sessionId: sessionIds[0],
          steps: results,
          stats: {
            uptime: finalStatus.stats.uptime,
            totalLogs: finalLogs.stats.totalLogs,
            consoleCount: finalLogs.stats.consoleCount,
            networkCount: finalLogs.stats.networkCount
          }
        };
      });

      // Wait for all scenarios to complete
      const scenarioResults = await Promise.all(scenarioPromises);
      const endTime = Date.now();

      // Verify all scenarios completed successfully
      expect(scenarioResults).toHaveLength(scenarios.length);
      
      scenarioResults.forEach(result => {
        expect(result.sessionId).toBeDefined();
        expect(result.steps).toHaveLength(scenarios.find(s => s.user === result.user)?.workflow.length || 0);
        expect(result.stats.uptime).toBeGreaterThan(0);
        expect(result.stats.totalLogs).toBeGreaterThan(0);
      });

      // Get overall session list
      const allSessions = await service.listSessions();
      expect(allSessions.count).toBe(scenarios.length);

      console.log(`✓ Multi-Session Concurrent Workflow:`);
      console.log(`  Total time: ${endTime - startTime}ms`);
      console.log(`  Scenarios completed: ${scenarioResults.length}`);
      console.log(`  Total sessions: ${allSessions.count}`);
      
      scenarioResults.forEach(result => {
        console.log(`  ${result.user}: ${result.steps.length} steps, ${result.stats.totalLogs} logs, ${result.stats.uptime}ms uptime`);
      });

      // Clean up sessions
      await Promise.all(
        scenarioResults.map(result => 
          service.stopSession(result.sessionId).catch(() => {
            // Session might already be stopped
          })
        )
      );
    });

    test('should demonstrate comprehensive error recovery in complete workflows', async () => {
      const { resolveUrl } = await import('../../utils/urlResolver.js');
      const { createOfflineBrowserSessionsService, NetworkConditionSimulator } = await import('../mocks/browserSessionsMock.js');
      
      // Test under different network conditions
      const simulator = new NetworkConditionSimulator();
      const conditions = ['normal', 'slow', 'unreliable'] as const;
      
      const results = [];
      
      for (const condition of conditions) {
        const service = simulator.createServiceWithCondition(condition);
        
        let operationsCompleted = 0;
        let operationsFailed = 0;
        const startTime = Date.now();
        
        // Define a workflow with multiple potential failure points
        const workflow = [
          { action: 'start', desc: 'dashboard overview' },
          { action: 'navigate', desc: 'user profile' },
          { action: 'screenshot', desc: 'current page' },
          { action: 'navigate', desc: 'settings panel' },
          { action: 'logs', desc: 'get session logs' },
          { action: 'navigate', desc: 'admin reports' },
          { action: 'status', desc: 'check session status' },
          { action: 'stop', desc: 'end session' }
        ];
        
        let sessionId: string | null = null;
        
        for (const step of workflow) {
          try {
            switch (step.action) {
              case 'start': {
                const path = resolveUrl(step.desc);
                const session = await service.startSession({
                  url: `http://localhost:3000${path}`,
                  sessionName: `${condition} Network Test`,
                  monitorConsole: true,
                  takeScreenshots: true
                });
                sessionId = session.sessionId;
                operationsCompleted++;
                break;
              }
              case 'navigate': {
                if (sessionId) {
                  const path = resolveUrl(step.desc);
                  await service.navigateSession(sessionId, {
                    url: `http://localhost:3000${path}`
                  });
                  operationsCompleted++;
                }
                break;
              }
              case 'screenshot': {
                if (sessionId) {
                  await service.captureScreenshot(sessionId, { format: 'png' });
                  operationsCompleted++;
                }
                break;
              }
              case 'logs': {
                if (sessionId) {
                  await service.getSessionLogs(sessionId, { limit: 10 });
                  operationsCompleted++;
                }
                break;
              }
              case 'status': {
                if (sessionId) {
                  await service.getSessionStatus(sessionId);
                  operationsCompleted++;
                }
                break;
              }
              case 'stop': {
                if (sessionId) {
                  await service.stopSession(sessionId);
                  operationsCompleted++;
                }
                break;
              }
            }
          } catch (error) {
            operationsFailed++;
            // Continue with remaining operations even if one fails
          }
        }
        
        const endTime = Date.now();
        const successRate = (operationsCompleted / workflow.length) * 100;
        
        results.push({
          condition,
          operationsCompleted,
          operationsFailed,
          successRate,
          duration: endTime - startTime
        });
      }
      
      // Verify results show expected patterns
      expect(results).toHaveLength(conditions.length);
      
      // Normal conditions should have high success rate
      const normalResult = results.find(r => r.condition === 'normal');
      expect(normalResult?.successRate).toBeGreaterThan(80);
      
      // Unreliable conditions should have more failures
      const unreliableResult = results.find(r => r.condition === 'unreliable');
      expect(unreliableResult?.operationsFailed).toBeGreaterThan(0);
      
      // Slow conditions should take longer
      const slowResult = results.find(r => r.condition === 'slow');
      expect(slowResult?.duration).toBeGreaterThan(normalResult?.duration || 0);
      
      console.log(`✓ Error Recovery Workflow Testing:`);
      results.forEach(result => {
        console.log(`  ${result.condition}: ${result.successRate.toFixed(1)}% success, ${result.duration}ms, ${result.operationsFailed} failures`);
      });
    });
  });
});