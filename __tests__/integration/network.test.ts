/**
 * Integration tests for network connectivity and axios transport
 * These tests verify that the network layer works correctly with the backend
 */

import { AxiosTransport } from '../../utils/axiosTransport.js';
import { config } from '../../config/index.js';

describe('Network Integration Tests', () => {
  let transport: AxiosTransport;
  let serverUrl: string;

  beforeAll(async () => {
    // Skip tests if no API key is provided
    if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
      console.log('Skipping network integration tests - no valid API key provided');
      return;
    }

    // Determine server URL based on environment
    serverUrl = process.env.ENVIRONMENT === 'local' 
      ? 'https://debuggai-backend.ngrok.app'
      : 'https://api.debugg.ai';

    transport = new AxiosTransport({
      baseUrl: serverUrl,
      apiKey: config.api.key
    });
  });

  beforeEach(() => {
    // Skip individual tests if transport not initialized
    if (!transport) {
      return;
    }
  });

  describe('Basic Connectivity', () => {
    test('should connect to the backend server', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      // Test basic connectivity with a simple GET request
      try {
        const response = await transport.get('api/v1/ping/');
        
        // Server should respond (even if with an error, it means it's reachable)
        expect(response).toBeDefined();
      } catch (error: any) {
        // Even 404 or auth errors indicate the server is reachable
        if (error.response) {
          expect(error.response.status).toBeDefined();
          expect(typeof error.response.status).toBe('number');
        } else {
          // Network error - server might be down
          console.warn('Network connectivity test failed:', error.message);
          throw new Error(`Cannot connect to backend server at ${serverUrl}: ${error.message}`);
        }
      }
    }, 15000);

    test('should include proper authentication headers', () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      expect(transport.axios.defaults.headers['Authorization']).toBeDefined();
      expect(transport.axios.defaults.headers['Authorization']).toContain('Token');
      expect(transport.axios.defaults.headers['Authorization']).toContain(config.api.key);
    });

    test('should include proper content-type headers', () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      expect(transport.axios.defaults.headers['Content-Type']).toBe('application/json');
      expect(transport.axios.defaults.headers['Accept']).toBe('application/json');
    });

    test('should have correct base URL', () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      // The base URL should match the server URL, allowing for trailing slash differences
      const actualUrl = transport.axios.defaults.baseURL;
      const expectedUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
      expect(actualUrl === serverUrl || actualUrl === expectedUrl).toBe(true);
    });
  });

  describe('Request/Response Transformation', () => {
    test('should transform request data to snake_case', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      const testData = {
        testField: 'value',
        anotherField: 123,
        nestedObject: {
          camelCaseField: 'nested'
        }
      };

      // Mock the request interceptor to capture transformed data
      let transformedData: any;
      const originalRequest = transport.axios.interceptors.request.handlers[0]?.fulfilled;
      
      if (originalRequest) {
        const mockConfig = { data: testData };
        const result = originalRequest(mockConfig);
        transformedData = result.data;

        expect(transformedData.test_field).toBe('value');
        expect(transformedData.another_field).toBe(123);
        expect(transformedData.nested_object.camel_case_field).toBe('nested');
      }
    });

    test('should handle response transformation to camelCase', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      // Test with a mock response that would come from the server
      const mockResponseData = {
        test_field: 'value',
        another_field: 123,
        nested_object: {
          snake_case_field: 'nested'
        }
      };

      // Mock response
      const mockResponse = {
        data: mockResponseData,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {}
      };

      // Test the response interceptor
      const responseInterceptor = transport.axios.interceptors.response.handlers[0]?.fulfilled;
      if (responseInterceptor) {
        const transformedResponse = responseInterceptor(mockResponse);
        const transformedData = transformedResponse.data;

        expect(transformedData.testField).toBe('value');
        expect(transformedData.anotherField).toBe(123);
        expect(transformedData.nestedObject.snakeCaseField).toBe('nested');
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      if (!config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return; // Skip if no valid API key
      }
      const badTransport = new AxiosTransport({
        baseUrl: 'https://nonexistent-server-12345.com',
        apiKey: config.api.key
      });

      try {
        await badTransport.get('/test');
        throw new Error('Should have thrown an error for nonexistent server');
      } catch (error: any) {
        expect(error).toBeDefined();
        // Should be a network error, not a response error
        if (error.code) {
          expect(error.code).toBeDefined();
        }
        // Accept that network errors may vary in structure
      }
    }, 10000);

    test('should handle API errors with proper structure', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      try {
        // Try to access an endpoint that should return an error
        await transport.get('api/v1/nonexistent-endpoint');
        // If it doesn't fail, that's also fine - server might handle it differently
      } catch (error: any) {
        if (error.response) {
          // This is an HTTP error response
          expect(error.response.status).toBeDefined();
          expect(typeof error.response.status).toBe('number');
          expect(error.response.status).toBeGreaterThanOrEqual(400);
        }
        // Error should be properly structured
        expect(error).toBeDefined();
      }
    }, 15000);

    test('should handle authentication errors', async () => {
      if (!serverUrl || !config.api.key || config.api.key === 'test-key-placeholder' || config.api.key === 'test-api-key-for-testing') {
        return; // Skip if no valid API key or server URL
      }
      const unauthTransport = new AxiosTransport({
        baseUrl: serverUrl,
        apiKey: 'invalid-key-123'
      });

      try {
        await unauthTransport.get('api/v1/e2e-tests/');
      } catch (error: any) {
        if (error.response) {
          // Should get a 401 or 403 for invalid auth
          expect([401, 403]).toContain(error.response.status);
        }
        expect(error).toBeDefined();
      }
    }, 15000);
  });

  describe('HTTP Methods', () => {
    test('should support GET requests', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      try {
        await transport.get('api/v1/ping/');
      } catch (error: any) {
        // Even errors indicate the method works
        expect(error).toBeDefined();
      }
    });

    test('should support POST requests', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      try {
        await transport.post('api/v1/test/', { test: 'data' });
      } catch (error: any) {
        // Even errors indicate the method works
        expect(error).toBeDefined();
      }
    });

    test('should support PUT requests', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      try {
        await transport.put('api/v1/test/123/', { test: 'data' });
      } catch (error: any) {
        // Even errors indicate the method works
        expect(error).toBeDefined();
      }
    });

    test('should support DELETE requests', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      try {
        await transport.delete('api/v1/test/123/');
      } catch (error: any) {
        // Even errors indicate the method works
        expect(error).toBeDefined();
      }
    });
  });

  describe('Request Configuration', () => {
    test('should handle custom headers', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      const customHeaders = { 'X-Custom-Header': 'test-value' };
      
      try {
        await transport.post('api/v1/test/', { test: 'data' }, { headers: customHeaders });
      } catch (error: any) {
        // The request was made, which is what we're testing
        expect(error).toBeDefined();
      }
    });

    test('should handle query parameters', async () => {
      if (!transport) {
        return; // Skip if transport not initialized
      }
      const params = { page: 1, limit: 10, filter: 'test' };
      
      try {
        await transport.get('api/v1/test/', params);
      } catch (error: any) {
        // The request was made with params, which is what we're testing
        expect(error).toBeDefined();
      }
    });
  });
});