export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      useESM: true
    }]
  },
  testRegex: '(/__tests__/.*/(test|spec)|\\.(test|spec))\\.(jsx?|tsx?)$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/__tests__/mocks/', '/__tests__/setup.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  collectCoverageFrom: ['**/*.{ts,tsx}', '!**/*.d.ts', '!**/node_modules/**', '!**/dist/**', '!**/__tests__/**'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  setupFiles: ['<rootDir>/__tests__/setup.ts']
};