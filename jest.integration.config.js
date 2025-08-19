/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  globals: {
    'ts-jest': {
      useESM: true,
    },
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
  },
  testMatch: [
    '**/__tests__/integration/**/*.test.ts'
  ],
  setupFilesAfterEnv: ['<rootDir>/__tests__/integration/setup.ts'],
  testTimeout: 90000, // 90 seconds for integration tests
  verbose: true,
  collectCoverageFrom: [
    'services/**/*.ts',
    'handlers/**/*.ts',
    'utils/**/*.ts',
    'e2e-agents/**/*.ts',
    '!**/*.d.ts',
    '!**/__tests__/**',
  ],
  coverageDirectory: 'coverage-integration',
  coverageReporters: ['text', 'lcov', 'html'],
  maxWorkers: 1, // Run integration tests sequentially to avoid API rate limits
};