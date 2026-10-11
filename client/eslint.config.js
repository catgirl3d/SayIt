import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.js', '**/*.cjs'],
  },
  js.configs.recommended,
  ...tseslint.configs['flat/recommended'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // The codebase intentionally declares a binding, assigns it once later, and
      // reads it from deferred closures in between (e.g. live system-audio tests).
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  eslintConfigPrettier,
];
