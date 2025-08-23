/**
 * Integration test setup
 * Configures environment and globals for integration tests
 */

// Configure test environment
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'local';

// Ensure API key is set for integration tests
if (!process.env.DEBUGGAI_API_KEY) {
  process.env.DEBUGGAI_API_KEY = '47c1f152f79e15e60b393c7ef8fe2674079b2e4d';
}