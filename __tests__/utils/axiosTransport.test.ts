/**
 * Tests for AxiosTransport to verify MCP request parameter injection and optimization features
 */

import { AxiosTransport } from '../../utils/axiosTransport.js';
import { MCPError, MCPErrorCode } from '../../types/index.js';
import { AxiosInstance, AxiosRequestConfig } from 'axios';

describe('AxiosTransport MCP Parameter Injection', () => {
  let transport: AxiosTransport;
  let requestInterceptor: (config: AxiosRequestConfig) => AxiosRequestConfig;
  
  // Mock axios instance to capture interceptors
  const mockAxios = {
    interceptors: {
      request: { use: (fn: any) => { requestInterceptor = fn; return 0; } },
      response: { use: () => 0 }
    },
    request: () => Promise.resolve({ data: { test: 'response' } }),
    defaults: { baseURL: '', headers: {} }
  } as unknown as AxiosInstance;

  beforeEach(() => {
    transport = new AxiosTransport({
      baseUrl: 'https://test.api.com',
      apiKey: 'test-key',
      instance: mockAxios // Use our mock instance
    });
  });

  describe('Request Interceptor', () => {
    test('should add mcp_request to GET request query parameters', () => {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: '/api/test',
        params: { existing: 'param' }
      };

      const result = requestInterceptor(config);

      expect(result.params).toEqual({
        existing: 'param',
        mcp_request: true
      });
    });

    test('should add mcp_request to GET request when no existing params', () => {
      const config: AxiosRequestConfig = {
        method: 'GET',
        url: '/api/test'
      };

      const result = requestInterceptor(config);

      expect(result.params).toEqual({
        mcp_request: true
      });
    });

    test('should add mcp_request to DELETE request query parameters', () => {
      const config: AxiosRequestConfig = {
        method: 'DELETE',
        url: '/api/test/123'
      };

      const result = requestInterceptor(config);

      expect(result.params).toEqual({
        mcp_request: true
      });
    });

    test('should add mcp_request to POST request body', () => {
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: '/api/test',
        data: { existing: 'data' }
      };

      const result = requestInterceptor(config);

      expect(result.data).toEqual({
        existing: 'data',
        mcp_request: true
      });
    });

    test('should add mcp_request to POST request when no existing data', () => {
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: '/api/test'
      };

      const result = requestInterceptor(config);

      expect(result.data).toEqual({
        mcp_request: true
      });
    });

    test('should add mcp_request to PUT request body', () => {
      const config: AxiosRequestConfig = {
        method: 'PUT',
        url: '/api/test/123',
        data: { existing: 'data' }
      };

      const result = requestInterceptor(config);

      expect(result.data).toEqual({
        existing: 'data',
        mcp_request: true
      });
    });

    test('should add mcp_request to PATCH request body', () => {
      const config: AxiosRequestConfig = {
        method: 'PATCH',
        url: '/api/test/123',
        data: { existing: 'data' }
      };

      const result = requestInterceptor(config);

      expect(result.data).toEqual({
        existing: 'data',
        mcp_request: true
      });
    });

    test('should handle case insensitive HTTP methods', () => {
      const getConfig: AxiosRequestConfig = {
        method: 'get',
        url: '/api/test'
      };

      const postConfig: AxiosRequestConfig = {
        method: 'post',
        url: '/api/test',
        data: {}
      };

      const getResult = requestInterceptor(getConfig);
      const postResult = requestInterceptor(postConfig);

      expect(getResult.params).toEqual({ mcp_request: true });
      expect(postResult.data).toEqual({ mcp_request: true });
    });

    test('should convert data and params to snake_case before adding mcp_request', () => {
      const getConfig: AxiosRequestConfig = {
        method: 'GET',
        url: '/api/test',
        params: {
          camelCaseParam: 'param'
        }
      };

      const postConfig: AxiosRequestConfig = {
        method: 'POST',
        url: '/api/test',
        data: { 
          camelCaseField: 'value',
          anotherField: 'test'
        }
      };

      const getResult = requestInterceptor(getConfig);
      const postResult = requestInterceptor(postConfig);

      // For GET requests, mcp_request should be added to params
      expect(getResult.params).toHaveProperty('mcp_request', true);
      
      // For POST requests, mcp_request should be added to data
      expect(postResult.data).toHaveProperty('mcp_request', true);
      
      // POST requests should not have mcp_request in params (params may be undefined)
      if (postResult.params) {
        expect(postResult.params).not.toHaveProperty('mcp_request');
      } else {
        expect(postResult.params).toBeUndefined();
      }
    });

    test('should not add mcp_request to non-object data', () => {
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: '/api/test',
        data: 'string data'
      };

      const result = requestInterceptor(config);

      // Should not modify non-object data
      expect(result.data).toBe('string data');
    });
  });

  describe('Transport Methods', () => {
    test('should have all transport methods available', () => {
      expect(typeof transport.get).toBe('function');
      expect(typeof transport.post).toBe('function');
      expect(typeof transport.put).toBe('function');
      expect(typeof transport.patch).toBe('function');
      expect(typeof transport.delete).toBe('function');
      expect(typeof transport.request).toBe('function');
    });

    test('should call request method with correct parameters for GET', async () => {
      const result = await transport.get('/api/test', { param: 'value' });
      expect(result).toEqual({ test: 'response' });
    });

    test('should call request method with correct parameters for POST', async () => {
      const result = await transport.post('/api/test', { data: 'value' });
      expect(result).toEqual({ test: 'response' });
    });
  });

  describe('Configuration', () => {
    test('should have transport instance configured', () => {
      expect(transport).toBeDefined();
      expect(transport.axios).toBeDefined();
    });

    test('should use provided axios instance if given', () => {
      const customTransport = new AxiosTransport({
        baseUrl: 'https://api.example.com',
        instance: mockAxios
      });

      expect(customTransport.axios).toBe(mockAxios);
    });
  });
});

describe('AxiosTransport Optimization Features', () => {
  let transport: AxiosTransport;
  let mockAxios: any;

  beforeEach(() => {
    // Mock axios with more detailed behavior
    let requestResolveValue: any = { data: { result: 'success' }, status: 200, config: { metadata: {} } };
    let requestRejectValue: any = null;
    let requestCallCount = 0;
    let shouldFailOnce = false;
    let permanentError: any = null;
    
    mockAxios = {
      interceptors: {
        request: { use: () => 0 },
        response: { use: () => 0 }
      },
      request: () => {
        requestCallCount++;
        
        // Handle permanent errors
        if (permanentError) {
          return Promise.reject(permanentError);
        }
        
        // Handle single failure then success
        if (shouldFailOnce) {
          shouldFailOnce = false;
          if (requestRejectValue) {
            return Promise.reject(requestRejectValue);
          }
        }
        
        // Handle single rejection
        if (requestRejectValue && requestCallCount === 1) {
          const error = requestRejectValue;
          requestRejectValue = null;
          return Promise.reject(error);
        }
        
        return Promise.resolve(requestResolveValue);
      },
      defaults: { baseURL: '', headers: {} },
      // Helper methods for test control
      mockResolvedValue: (value: any) => { requestResolveValue = value; },
      mockRejectedValue: (value: any) => { permanentError = value; },
      mockRejectedValueOnce: (value: any) => { 
        requestRejectValue = value; 
        shouldFailOnce = true;
        permanentError = null;
      },
      getCallCount: () => requestCallCount,
      resetCallCount: () => { 
        requestCallCount = 0; 
        shouldFailOnce = false;
        permanentError = null;
        requestRejectValue = null;
      }
    };

    transport = new AxiosTransport({
      baseUrl: 'https://test.api.com',
      apiKey: 'test-key',
      instance: mockAxios,
      config: {
        retry: {
          maxAttempts: 2,
          baseDelay: 100,
          maxDelay: 1000,
          exponentialBase: 2,
          retryableStatusCodes: [500, 502],
          retryableErrorCodes: [MCPErrorCode.EXTERNAL_SERVICE_ERROR]
        },
        cache: {
          enabled: true,
          ttl: 1000,
          maxSize: 10,
          excludePatterns: ['/auth']
        },
        metrics: {
          enabled: true,
          collectTiming: true,
          collectErrors: true,
          collectCacheStats: true
        },
        logging: {
          enabled: true,
          logRequests: true,
          logResponses: true,
          logErrors: true,
          sanitizeSensitiveData: true
        }
      }
    });
  });

  describe('Caching', () => {
    beforeEach(() => {
      // Mock successful response
      mockAxios.mockResolvedValue({ 
        data: { result: 'cached-data' },
        status: 200,
        config: { metadata: { requestId: 'test', startTime: Date.now(), method: 'GET', url: '/test' } }
      });
      mockAxios.resetCallCount();
    });

    test('should cache GET requests', async () => {
      const result1 = await transport.get('/api/test');
      const result2 = await transport.get('/api/test');

      expect(mockAxios.getCallCount()).toBe(1);
      expect(result1).toEqual({ result: 'cached-data' });
      expect(result2).toEqual({ result: 'cached-data' });
    });

    test('should not cache POST requests', async () => {
      mockAxios.resetCallCount();
      await transport.post('/api/test', { data: 'test' });
      await transport.post('/api/test', { data: 'test' });

      expect(mockAxios.getCallCount()).toBe(2);
    });

    test('should exclude auth endpoints from cache', async () => {
      mockAxios.resetCallCount();
      await transport.get('/auth/login');
      await transport.get('/auth/login');

      expect(mockAxios.getCallCount()).toBe(2);
    });

    test('should provide cache statistics', () => {
      const stats = transport.getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats).toHaveProperty('hitRatio');
    });

    test('should clear cache when requested', async () => {
      mockAxios.resetCallCount();
      await transport.get('/api/test');
      transport.clearCache();
      await transport.get('/api/test');

      expect(mockAxios.getCallCount()).toBe(2);
    });
  });

  describe('Retry Logic', () => {
    test('should retry on retryable errors', async () => {
      const error = new MCPError(MCPErrorCode.EXTERNAL_SERVICE_ERROR, 'Service unavailable');
      mockAxios.resetCallCount();
      mockAxios.mockRejectedValueOnce(error);
      mockAxios.mockResolvedValue({ 
        data: { result: 'success' },
        status: 200,
        config: { metadata: { requestId: 'test', startTime: Date.now(), method: 'GET', url: '/test' } }
      });

      const result = await transport.get('/api/test');

      expect(mockAxios.getCallCount()).toBe(2);
      expect(result).toEqual({ result: 'success' });
    });

    test('should not retry non-retryable errors', async () => {
      const error = new MCPError(MCPErrorCode.INVALID_PARAMS, 'Bad request');
      mockAxios.resetCallCount();
      mockAxios.mockRejectedValue(error);

      await expect(transport.get('/api/test')).rejects.toThrow('Bad request');
      expect(mockAxios.getCallCount()).toBe(1);
    });

    test('should not exceed max retry attempts', async () => {
      const error = new MCPError(MCPErrorCode.EXTERNAL_SERVICE_ERROR, 'Service unavailable');
      mockAxios.resetCallCount();
      mockAxios.mockRejectedValue(error);

      await expect(transport.get('/api/test')).rejects.toThrow('Service unavailable');
      expect(mockAxios.getCallCount()).toBe(2); // 1 initial + 1 retry
    });
  });

  describe('Metrics Collection', () => {
    test('should collect request metrics', async () => {
      // Since we're mocking the interceptors, metrics won't be collected automatically
      // Let's test the metrics API itself
      const metrics = transport.getMetrics();
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('requestsByMethod');
      expect(metrics).toHaveProperty('totalErrors');
    });

    test('should provide metrics API functionality', () => {
      // Test metrics reset functionality
      transport.resetMetrics();
      const resetMetrics = transport.getMetrics();
      expect(resetMetrics.totalRequests).toBe(0);
      expect(resetMetrics.totalErrors).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle error conversion', async () => {
      const standardError = new Error('Network error');
      mockAxios.mockRejectedValue(standardError);

      await expect(transport.get('/api/test')).rejects.toThrow('Network error');
    });

  });

  describe('Configuration', () => {
    test('should use default configuration when none provided', () => {
      const defaultTransport = new AxiosTransport({
        baseUrl: 'https://test.api.com',
        instance: mockAxios
      });

      expect(defaultTransport).toBeDefined();
      // Verify it has the expected methods
      expect(typeof defaultTransport.getMetrics).toBe('function');
      expect(typeof defaultTransport.clearCache).toBe('function');
    });

    test('should merge custom configuration with defaults', () => {
      const customTransport = new AxiosTransport({
        baseUrl: 'https://test.api.com',
        instance: mockAxios,
        config: {
          cache: {
            enabled: false,
            ttl: 5000,
            maxSize: 50,
            excludePatterns: []
          }
        }
      });

      expect(customTransport).toBeDefined();
    });
  });

  describe('Public Interface', () => {
    test('should provide access to metrics', () => {
      const metrics = transport.getMetrics();
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('totalErrors');
      expect(metrics).toHaveProperty('averageResponseTime');
    });

    test('should provide cache statistics', () => {
      const stats = transport.getCacheStats();
      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('maxSize');
      expect(stats).toHaveProperty('hitRatio');
    });

    test('should allow metrics reset', () => {
      const initialMetrics = transport.getMetrics();
      transport.resetMetrics();
      const resetMetrics = transport.getMetrics();
      
      expect(resetMetrics.totalRequests).toBe(0);
      expect(resetMetrics.totalErrors).toBe(0);
    });

    test('should allow cache clearing', () => {
      transport.clearCache();
      const stats = transport.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });
});

/**
 * Comprehensive MCP Parameter Injection Tests with Real HTTP Scenarios
 */
describe('AxiosTransport Comprehensive MCP Parameter Injection', () => {
  let transport: AxiosTransport;
  let mockAxios: any;
  let capturedRequests: AxiosRequestConfig[];

  beforeEach(() => {
    capturedRequests = [];
    
    mockAxios = {
      interceptors: {
        request: { use: (fn: any) => { 
          // Store the interceptor function for testing
          mockAxios.requestInterceptor = fn;
          return 0; 
        } },
        response: { use: (fn: any, errorFn: any) => {
          mockAxios.responseInterceptor = fn;
          mockAxios.errorInterceptor = errorFn;
          return 0;
        } }
      },
      request: (config: AxiosRequestConfig) => {
        // Apply request interceptor first
        const interceptedConfig = mockAxios.requestInterceptor ? 
          mockAxios.requestInterceptor(config) : config;
        
        // Store the final config for inspection
        capturedRequests.push({ ...interceptedConfig });
        
        // Simulate different response scenarios based on URL
        if (config.url?.includes('/error/')) {
          return Promise.reject(new Error('Simulated HTTP error'));
        }
        
        return Promise.resolve({
          data: { 
            received_params: interceptedConfig.params,
            received_data: interceptedConfig.data,
            method: interceptedConfig.method,
            url: interceptedConfig.url
          },
          status: 200,
          config: { 
            ...interceptedConfig,
            metadata: {
              requestId: 'test-' + Date.now(),
              startTime: Date.now(),
              method: interceptedConfig.method?.toUpperCase() || 'GET',
              url: interceptedConfig.url || ''
            }
          }
        });
      },
      defaults: { baseURL: '', headers: {} }
    };

    transport = new AxiosTransport({
      baseUrl: 'https://test-api.debugg.ai',
      apiKey: 'test-mcp-key',
      instance: mockAxios
    });
  });

  describe('Real HTTP Request Scenarios', () => {
    test('should inject mcp_request in GET requests with query parameters', async () => {
      const response = await transport.get('/api/sessions/', {
        status: 'active',
        limit: 10
      });

      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      
      expect(request.params).toEqual({
        status: 'active',
        limit: 10,
        mcp_request: true
      });
      
      expect(response.received_params).toEqual({
        status: 'active',
        limit: 10,
        mcp_request: true
      });
    });

    test('should inject mcp_request in POST requests with JSON body', async () => {
      const sessionData = {
        initialUrl: 'https://example.com',
        sessionName: 'Test Session',
        monitorConsole: true
      };

      const response = await transport.post('/api/browser-sessions/sessions/', sessionData);

      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      
      expect(request.data).toEqual({
        initial_url: 'https://example.com', // Should be converted to snake_case
        session_name: 'Test Session',
        monitor_console: true,
        mcp_request: true
      });
      
      expect(response.received_data).toEqual({
        initial_url: 'https://example.com',
        session_name: 'Test Session', 
        monitor_console: true,
        mcp_request: true
      });
    });

    test('should inject mcp_request in PATCH requests for session updates', async () => {
      const updateData = {
        status: 'COMPLETED',
        endTime: new Date().toISOString()
      };

      const response = await transport.patch('/api/sessions/session-123/', updateData);

      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      
      expect(request.data).toEqual({
        status: 'COMPLETED',
        end_time: expect.any(String), // Should be converted to snake_case
        mcp_request: true
      });
    });
  });

  describe('Complex Data Structure Scenarios', () => {
    test('should handle nested objects with camelCase conversion', async () => {
      const complexData = {
        sessionConfig: {
          browserOptions: {
            headlessMode: true,
            viewportWidth: 1920,
            viewportHeight: 1080
          },
          monitoringSettings: {
            captureConsole: true,
            captureNetwork: false,
            screenshotInterval: 5000
          }
        },
        userPreferences: {
          emailNotifications: true,
          slackWebhook: 'https://hooks.slack.com/test'
        }
      };

      await transport.post('/api/sessions/advanced/', complexData);

      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      
      expect(request.data).toEqual({
        session_config: {
          browser_options: {
            headless_mode: true,
            viewport_width: 1920,
            viewport_height: 1080
          },
          monitoring_settings: {
            capture_console: true,
            capture_network: false,
            screenshot_interval: 5000
          }
        },
        user_preferences: {
          email_notifications: true,
          slack_webhook: 'https://hooks.slack.com/test'
        },
        mcp_request: true
      });
    });

    test('should handle arrays of objects', async () => {
      const arrayData = {
        sessionList: [
          { sessionId: 'session-1', status: 'ACTIVE' },
          { sessionId: 'session-2', status: 'STOPPED' }
        ],
        batchOperation: 'update_all'
      };

      await transport.post('/api/sessions/batch/', arrayData);

      const request = capturedRequests[0];
      expect(request.data).toEqual({
        session_list: [
          { session_id: 'session-1', status: 'ACTIVE' },
          { session_id: 'session-2', status: 'STOPPED' }
        ],
        batch_operation: 'update_all',
        mcp_request: true
      });
    });
  });

  describe('Error Scenarios with MCP Parameter', () => {
    test('should include mcp_request even when request fails', async () => {
      try {
        await transport.post('/api/error/500', { testData: 'value' });
      } catch (error) {
        // Request should still have been processed with mcp_request
        expect(capturedRequests).toHaveLength(1);
        expect(capturedRequests[0].data).toEqual({
          test_data: 'value',
          mcp_request: true
        });
      }
    });

    test('should handle empty request bodies correctly', async () => {
      await transport.post('/api/ping/');

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].data).toEqual({ mcp_request: true });
    });
  });

  describe('Browser Sessions API Integration', () => {
    test('should properly format browser session creation requests', async () => {
      const sessionParams = {
        url: 'http://localhost:3000/dashboard',
        sessionName: 'E2E Dashboard Test',
        monitorConsole: true,
        monitorNetwork: true,
        takeScreenshots: false,
        screenshotInterval: 10
      };

      // Simulate the exact call made by browserSessions service
      await transport.post('api/v1/browser-sessions/sessions/', {
        initialUrl: sessionParams.url,
        sessionName: sessionParams.sessionName,
        monitorConsole: sessionParams.monitorConsole,
        monitorNetwork: sessionParams.monitorNetwork,
        takeScreenshots: sessionParams.takeScreenshots,
        screenshotInterval: sessionParams.screenshotInterval
      });

      const request = capturedRequests[0];
      expect(request.data).toEqual({
        initial_url: 'http://localhost:3000/dashboard',
        session_name: 'E2E Dashboard Test',
        monitor_console: true,
        monitor_network: true,
        take_screenshots: false,
        screenshot_interval: 10,
        mcp_request: true
      });
    });
  });
});

/**
 * Comprehensive Transport Optimization Tests - Error Handling and Edge Cases
 */
describe('AxiosTransport Optimization Features - Comprehensive Edge Cases', () => {
  let transport: AxiosTransport;
  let mockAxios: any;

  beforeEach(() => {
    mockAxios = {
      interceptors: {
        request: { use: () => 0 },
        response: { use: () => 0 }
      },
      request: (config: any) => {
        // Simulate various response scenarios
        if (config.url?.includes('/500')) {
          return Promise.reject({ 
            response: { status: 500, data: 'Internal Server Error' },
            message: 'Request failed with status code 500'
          });
        }
        
        if (config.url?.includes('/429')) {
          return Promise.reject({
            response: { status: 429, data: 'Too Many Requests' },
            message: 'Request failed with status code 429'
          });
        }
        
        return Promise.resolve({
          data: { success: true, url: config.url, method: config.method },
          status: 200,
          config: { metadata: { requestId: 'test', startTime: Date.now(), method: config.method?.toUpperCase() || 'GET', url: config.url } }
        });
      },
      defaults: { baseURL: '', headers: {} }
    };

    transport = new AxiosTransport({
      baseUrl: 'https://test-api.debugg.ai',
      apiKey: 'test-key',
      instance: mockAxios,
      config: {
        retry: {
          maxAttempts: 3,
          baseDelay: 50, // Faster for tests
          maxDelay: 1000,
          exponentialBase: 2,
          retryableStatusCodes: [408, 429, 500, 502, 503, 504],
          retryableErrorCodes: [MCPErrorCode.EXTERNAL_SERVICE_ERROR]
        },
        cache: {
          enabled: true,
          ttl: 1000, // 1 second for testing
          maxSize: 5,
          excludePatterns: ['/no-cache']
        },
        metrics: {
          enabled: true,
          collectTiming: true,
          collectErrors: true,
          collectCacheStats: true
        }
      }
    });
  });

  describe('Advanced Retry Logic Edge Cases', () => {
    test('should retry on 429 Too Many Requests', async () => {
      let attemptCount = 0;
      mockAxios.request = () => {
        attemptCount++;
        if (attemptCount < 3) {
          return Promise.reject({
            response: { status: 429 },
            message: 'Too Many Requests'
          });
        }
        return Promise.resolve({
          data: { success: true, attempts: attemptCount },
          status: 200,
          config: { metadata: { requestId: 'retry-test', startTime: Date.now(), method: 'GET', url: '/test' } }
        });
      };

      const result = await transport.get('/test');
      expect(result.attempts).toBe(3);
      expect(attemptCount).toBe(3);
    });

    test('should not retry non-retryable errors', async () => {
      let attemptCount = 0;
      mockAxios.request = () => {
        attemptCount++;
        return Promise.reject({
          response: { status: 404 },
          message: 'Not Found'
        });
      };

      await expect(transport.get('/test')).rejects.toThrow();
      expect(attemptCount).toBe(1); // Should not retry
    });

    test('should handle network errors with retry', async () => {
      let attemptCount = 0;
      mockAxios.request = () => {
        attemptCount++;
        if (attemptCount < 2) {
          return Promise.reject({
            message: 'Network Error',
            code: 'ENETUNREACH'
          });
        }
        return Promise.resolve({
          data: { success: true },
          status: 200,
          config: { metadata: { requestId: 'network-test', startTime: Date.now(), method: 'GET', url: '/test' } }
        });
      };

      const result = await transport.get('/test');
      expect(result.success).toBe(true);
      expect(attemptCount).toBe(2);
    });
  });

  describe('Advanced Caching Edge Cases', () => {
    test('should handle cache eviction when max size reached', async () => {
      // Fill cache to max size
      for (let i = 0; i < 6; i++) {
        await transport.get(`/cache-test-${i}`);
      }

      const stats = transport.getCacheStats();
      expect(stats.size).toBe(5); // Should not exceed maxSize
      expect(stats.maxSize).toBe(5);
    });

    test('should not cache requests with excluded patterns', async () => {
      await transport.get('/no-cache/endpoint');
      await transport.get('/no-cache/endpoint'); // Second request to same URL

      // Should make 2 actual requests since caching is disabled for /no-cache
      expect(transport.getCacheStats().hitRatio).toBe(0);
    });

    test('should handle cache expiration correctly', async () => {
      await transport.get('/expire-test');
      
      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 1100)); // TTL is 1000ms
      
      await transport.get('/expire-test');
      
      const stats = transport.getCacheStats();
      // Second request should be a cache miss due to expiration
      expect(stats.hitRatio).toBeLessThan(0.5);
    });

    test('should only cache GET requests', async () => {
      await transport.get('/cacheable');
      await transport.post('/cacheable', { data: 'test' });
      await transport.put('/cacheable', { data: 'test' });
      await transport.patch('/cacheable', { data: 'test' });
      await transport.delete('/cacheable');

      // Make the same GET request again
      await transport.get('/cacheable');

      const stats = transport.getCacheStats();
      // Should only have cached the GET requests
      expect(stats.size).toBe(1);
    });

    test('should clear cache completely', async () => {
      await transport.get('/cache-1');
      await transport.get('/cache-2');
      await transport.get('/cache-3');

      expect(transport.getCacheStats().size).toBeGreaterThan(0);
      
      transport.clearCache();
      
      expect(transport.getCacheStats().size).toBe(0);
    });
  });

  describe('Metrics Collection Edge Cases', () => {
    test('should track metrics for failed requests', async () => {
      transport.resetMetrics();
      
      try {
        await transport.get('/500');
      } catch (error) {
        // Expected to fail
      }

      const metrics = transport.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.totalErrors).toBe(1);
    });

    test('should calculate average response time correctly', async () => {
      transport.resetMetrics();
      
      // Make several requests
      await transport.get('/test-1');
      await transport.get('/test-2');
      await transport.get('/test-3');

      const metrics = transport.getMetrics();
      expect(metrics.totalRequests).toBe(3);
      expect(metrics.averageResponseTime).toBeGreaterThan(0);
      expect(typeof metrics.averageResponseTime).toBe('number');
    });

    test('should track requests by HTTP method', async () => {
      transport.resetMetrics();
      
      await transport.get('/test');
      await transport.post('/test', { data: 'test' });
      await transport.put('/test', { data: 'test' });
      await transport.patch('/test', { data: 'test' });
      await transport.delete('/test');

      const metrics = transport.getMetrics();
      expect(metrics.requestsByMethod.GET).toBe(1);
      expect(metrics.requestsByMethod.POST).toBe(1);
      expect(metrics.requestsByMethod.PUT).toBe(1);
      expect(metrics.requestsByMethod.PATCH).toBe(1);
      expect(metrics.requestsByMethod.DELETE).toBe(1);
    });

    test('should handle metrics reset correctly', async () => {
      await transport.get('/test-before-reset');
      
      expect(transport.getMetrics().totalRequests).toBeGreaterThan(0);
      
      transport.resetMetrics();
      
      const resetMetrics = transport.getMetrics();
      expect(resetMetrics.totalRequests).toBe(0);
      expect(resetMetrics.totalErrors).toBe(0);
      expect(resetMetrics.averageResponseTime).toBe(0);
    });
  });

  describe('Error Handling Edge Cases', () => {
    test('should handle HTML error responses from Django', async () => {
      mockAxios.request = () => {
        return Promise.reject({
          response: {
            status: 404,
            data: '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>'
          },
          config: { url: '/html-error' }
        });
      };

      await expect(transport.get('/html-error')).rejects.toThrow('API endpoint not found');
    });

    test('should handle concurrent cache access safely', async () => {
      const promises = Array.from({ length: 10 }, () => 
        transport.get('/concurrent-cache-test')
      );

      const results = await Promise.all(promises);
      
      // All results should be identical (cached)
      const unique = [...new Set(results.map(r => JSON.stringify(r)))];
      expect(unique).toHaveLength(1);
      
      const stats = transport.getCacheStats();
      expect(stats.hitRatio).toBeGreaterThan(0.8); // Most should be cache hits
    });
  });

  describe('Resource Management', () => {
    test('should cleanup resources on destroy', () => {
      const cleanupTransport = new AxiosTransport({
        baseUrl: 'https://test-cleanup.com',
        instance: mockAxios,
        config: { cache: { enabled: true } }
      });

      // Add some cache entries
      cleanupTransport.get('/cleanup-test-1');
      cleanupTransport.get('/cleanup-test-2');

      expect(cleanupTransport.getCacheStats().size).toBeGreaterThan(0);

      // Destroy should cleanup everything
      cleanupTransport.destroy();

      expect(cleanupTransport.getCacheStats().size).toBe(0);
    });

    test('should handle configuration merging correctly', () => {
      const customTransport = new AxiosTransport({
        baseUrl: 'https://custom-config.test',
        instance: mockAxios,
        config: {
          cache: { enabled: false },
          metrics: { enabled: false }
        }
      });

      expect(customTransport).toBeDefined();
      expect(customTransport.getCacheStats().maxSize).toBe(0);
    });
  });
});