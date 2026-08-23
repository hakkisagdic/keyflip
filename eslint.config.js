'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');

module.exports = [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        global: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      quotes: ['warn', 'single', { avoidEscape: true }],
      semi: ['warn', 'always'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': 'warn',
      'no-constant-condition': 'warn',
      'no-redeclare': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'no-regex-spaces': 'warn',
      'no-useless-assignment': 'warn',
      'no-unused-private-class-members': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', '.husky/'],
  },
];
