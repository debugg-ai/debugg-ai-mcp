import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'reference-usages/**', '__tests__/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      // stdout is the MCP JSON-RPC transport — any console.log corrupts the stream
      'no-console': 'error',
      // Allow unused vars prefixed with _ (common pattern)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Allow explicit any in this codebase (MCP SDK types are loose)
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow empty interfaces extending a type (used for paginated response types)
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
);
