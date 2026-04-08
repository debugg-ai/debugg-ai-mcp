/**
 * Jest setup file for DebuggAI MCP Server tests
 * Sets up environment variables and global mocks
 */

// Set required environment variables for testing
// Only set API key if not already provided (allows real API key to be used for integration tests)
if (!process.env.DEBUGGAI_API_KEY) {
  process.env.DEBUGGAI_API_KEY = 'test-api-key-for-testing';
}
// Only set ENVIRONMENT to 'test' if not already set (allows 'local' for integration tests)
if (!process.env.ENVIRONMENT) {
  process.env.ENVIRONMENT = 'test';
}
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests


// Mock global functions that might not be available in test environment
if (typeof global.fetch === 'undefined') {
  global.fetch = () => Promise.resolve({} as Response);
}