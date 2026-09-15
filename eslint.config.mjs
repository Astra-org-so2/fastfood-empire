import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.data/**',
      '**/.workspaces/**',
      'apps/desktop/renderer/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Unused args are allowed when prefixed with _ (common for interface impls).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'warn',
      // Guard rails that matter for this codebase specifically.
      'no-restricted-syntax': [
        'warn',
        {
          selector: "MemberExpression[object.name='process'][property.name='env'][computed=false]",
          message: 'Read configuration through @aido/config instead of process.env so it stays validated and documented.',
        },
      ],
    },
  },
  {
    // Config/scripts legitimately touch env and console output.
    files: ['packages/config/**', 'scripts/**', '**/*.config.ts', '**/*.config.mjs', 'apps/desktop/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.ts', 'test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['apps/web/**/*.tsx', 'packages/ui/**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
