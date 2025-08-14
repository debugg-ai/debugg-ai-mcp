/**
 * Jest setup file for DebuggAI MCP Server tests
 * Sets up environment variables and global mocks
 */

// Set required environment variables for testing
process.env.DEBUGGAI_API_KEY = 'test-api-key-for-testing';
process.env.ENVIRONMENT = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests

// Optional environment variables
process.env.DEBUGGAI_LOCAL_PORT = '3000';
process.env.DEBUGGAI_LOCAL_REPO_NAME = 'test-repo';
process.env.DEBUGGAI_LOCAL_BRANCH_NAME = 'test-branch';
process.env.DEBUGGAI_LOCAL_REPO_PATH = '/test/repo/path';
process.env.DEBUGGAI_LOCAL_FILE_PATH = '/test/file/path';

// Mock global functions that might not be available in test environment
if (typeof global.fetch === 'undefined') {
  global.fetch = () => Promise.resolve({} as Response);
}